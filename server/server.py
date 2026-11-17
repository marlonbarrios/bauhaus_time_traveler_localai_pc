"""
StreamCam server: real-time webcam img2img with StreamDiffusion
plus local speech-to-text with Whisper.

  Apple Silicon: MPS + mlx-whisper
  Windows / NVIDIA: CUDA + faster-whisper


  WebSocket /ws          binary JPEG frame in -> binary JPEG frame out
                         text JSON {"type":"prompt","prompt":...}
                         text JSON {"type":"params","strength":0..1,"steps":1|2,"seed":int}
  POST /transcribe       raw little-endian float32 PCM, mono 16 kHz -> {"text": ...}
  GET  /health           {"ready": bool, ...}
  GET  /                 the JavaScript UI (../app)
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# All model files live in the project folder. Set this before Hugging Face is imported.
os.environ["HF_HOME"] = str(Path(__file__).resolve().parent.parent / "models")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

import asyncio
import io
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import torch
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

MODEL_ID = os.environ.get("SD_MODEL", "stabilityai/sd-turbo")
TINY_VAE_ID = os.environ.get("SD_TINY_VAE", "madebyollin/taesd")
# MLX weights only run on Apple Silicon. Windows uses PyTorch Whisper: the CTranslate2
# build is blocked on this machine by Application Control.
_ON_MAC = sys.platform == "darwin"
WHISPER_ID = os.environ.get(
    "WHISPER_MODEL",
    "mlx-community/whisper-large-v3-turbo" if _ON_MAC else "openai/whisper-large-v3-turbo",
)
# Word portal: a small model is much faster, with the same accuracy for keywords.
WHISPER_FAST_ID = os.environ.get(
    "WHISPER_FAST_MODEL",
    "mlx-community/whisper-small-mlx" if _ON_MAC else "openai/whisper-small",
)
SIZE = int(os.environ.get("SD_SIZE", "512"))
PORT = int(os.environ.get("PORT", "7860"))
APP_DIR = Path(__file__).resolve().parent.parent / "app"

if torch.cuda.is_available():
    DEVICE = torch.device("cuda")
    DTYPE = torch.float16
    torch.backends.cudnn.benchmark = True
elif getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
    DEVICE = torch.device("mps")
    DTYPE = torch.float16
else:
    DEVICE = torch.device("cpu")
    DTYPE = torch.float32

# All torch work happens on one thread (the stream object is not safe to share);
# Whisper gets its own thread so talking never blocks the video loop.
gpu_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="diffusion")
stt_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="whisper")


class Engine:
    NUM_STEPS = 50  # scheduler grid; t_index picks a point on it
    MAX_CHUNKS = 3  # up to ~225 prompt tokens

    def __init__(self) -> None:
        from diffusers import AutoencoderTiny, StableDiffusionPipeline

        print(f"[engine] loading {MODEL_ID} on {DEVICE} ({DTYPE})", flush=True)
        self.pipe = StableDiffusionPipeline.from_pretrained(
            MODEL_ID, torch_dtype=DTYPE, safety_checker=None
        ).to(DEVICE)
        self.pipe.set_progress_bar_config(disable=True)
        self.tiny_vae = AutoencoderTiny.from_pretrained(TINY_VAE_ID, torch_dtype=DTYPE).to(DEVICE)

        self.prompt = "a portrait"
        self.style = ""  # "system prompt": always appended; the UI sends it on connect
        self.strength = 0.75  # 0 = keep webcam, 1 = ignore webcam
        self.steps = 1
        self.seed = 2
        self.stream = None
        self._build()

    # strength -> timestep index. Higher index = less noise = closer to the camera.
    def _t_index_list(self) -> list[int]:
        t = int(round(48 - self.strength * 40))  # 8 .. 48
        t = max(1, min(48, t))
        if self.steps == 1:
            return [t]
        return [t, min(49, t + max(1, (49 - t) // 2))]

    def _build(self) -> None:
        from streamdiffusion import StreamDiffusion

        stream = StreamDiffusion(
            self.pipe,
            t_index_list=self._t_index_list(),
            torch_dtype=DTYPE,
            width=SIZE,
            height=SIZE,
            cfg_type="none",  # sd-turbo is guidance-free
        )
        stream.vae = self.tiny_vae
        # No similar-image filter: it skips frames when the camera is still, which hid prompt changes.
        stream.prepare(
            prompt=self.full_prompt(),
            num_inference_steps=self.NUM_STEPS,
            guidance_scale=0.0,
            seed=self.seed,
            generator=torch.Generator(),
        )
        self.stream = stream
        self._apply_prompt()  # full-length prompt (prepare() truncates at 77 tokens)
        # warm up so the first real frame is not slow
        blank = Image.new("RGB", (SIZE, SIZE), (127, 127, 127))
        for _ in range(len(stream.t_list) + 1):
            stream(blank)

    def full_prompt(self) -> str:
        parts = [p.strip().rstrip(",.") for p in (self.prompt, self.style) if p and p.strip()]
        return ", ".join(parts)

    @torch.no_grad()
    def _encode_long(self, text: str) -> torch.Tensor:
        """CLIP only sees 77 tokens. Encode the prompt in 75-token chunks and concatenate them,
        so long style prompts are not cut off (the UNet accepts any sequence length)."""
        tok = self.pipe.tokenizer
        ids = tok(text, add_special_tokens=False, truncation=False).input_ids or [tok.eos_token_id]
        chunks = [ids[i : i + 75] for i in range(0, len(ids), 75)][: self.MAX_CHUNKS]
        pad = tok.pad_token_id if tok.pad_token_id is not None else tok.eos_token_id
        embeds = []
        for c in chunks:
            row = [tok.bos_token_id] + c + [tok.eos_token_id]
            row += [pad] * (77 - len(row))
            out = self.pipe.text_encoder(torch.tensor([row], device=DEVICE))[0]
            embeds.append(out)
        return torch.cat(embeds, dim=1).to(DTYPE)

    def _apply_prompt(self) -> None:
        emb = self._encode_long(self.full_prompt())
        self.stream.prompt_embeds = emb.repeat(self.stream.batch_size, 1, 1)

    def set_prompt(self, prompt: str, style: str | None = None) -> None:
        prompt = (prompt or "").strip()
        new_style = self.style if style is None else style.strip()
        if (prompt or new_style) and (prompt, new_style) != (self.prompt, self.style):
            self.prompt, self.style = prompt, new_style
            self._apply_prompt()

    def set_params(self, strength=None, steps=None, seed=None) -> None:
        changed = False
        if strength is not None and abs(float(strength) - self.strength) > 1e-3:
            self.strength = float(min(1.0, max(0.0, strength)))
            changed = True
        if steps is not None and int(steps) in (1, 2) and int(steps) != self.steps:
            self.steps = int(steps)
            changed = True
        if seed is not None and int(seed) != self.seed:
            self.seed = int(seed)
            changed = True
        if changed:
            self._build()

    @torch.no_grad()
    def process(self, jpeg: bytes) -> bytes:
        from streamdiffusion.image_utils import postprocess_image

        img = Image.open(io.BytesIO(jpeg)).convert("RGB")
        if img.size != (SIZE, SIZE):
            img = img.resize((SIZE, SIZE), Image.BICUBIC)
        out = self.stream(img)
        pil = postprocess_image(out, output_type="pil")[0]
        buf = io.BytesIO()
        pil.save(buf, format="JPEG", quality=88)
        return buf.getvalue()

    def state(self) -> dict:
        return {"prompt": self.prompt, "style": self.style, "strength": self.strength, "steps": self.steps, "seed": self.seed}


class Transcriber:
    def __init__(self) -> None:
        self._mlx = None
        self._torch_models: dict[bool, tuple] = {}
        if _ON_MAC:
            self._init_mlx()
        else:
            self._init_torch()
        silence = np.zeros(16000, dtype=np.float32)
        self.transcribe(silence)
        self.transcribe(silence, fast=True)

    def _init_mlx(self) -> None:
        import importlib

        import mlx_whisper

        mw = importlib.import_module("mlx_whisper.transcribe")  # the module (the package attribute is a function)

        # mlx-whisper keeps only ONE model in memory; keep both loaded so switching costs nothing
        cache: dict = {}

        def get_model(cls, model_path, dtype):
            key = (model_path, str(dtype))
            if key not in cache:
                cache[key] = mw.load_model(model_path, dtype=dtype)
            return cache[key]

        mw.ModelHolder.get_model = classmethod(get_model)
        self._mlx = mlx_whisper

    def _init_torch(self) -> None:
        from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor

        dtype = torch.float16 if DEVICE.type == "cuda" else torch.float32
        print(f"[whisper] loading on {DEVICE} ({dtype})", flush=True)
        for fast, repo in ((False, WHISPER_ID), (True, WHISPER_FAST_ID)):
            processor = AutoProcessor.from_pretrained(repo)
            model = AutoModelForSpeechSeq2Seq.from_pretrained(repo, torch_dtype=dtype).to(DEVICE)
            model.eval()
            self._torch_models[fast] = (processor, model)

    def transcribe(self, audio: np.ndarray, fast: bool = False) -> str:
        language = os.environ.get("WHISPER_LANGUAGE") or None
        if self._mlx is not None:
            result = self._mlx.transcribe(
                audio,
                path_or_hf_repo=WHISPER_FAST_ID if fast else WHISPER_ID,
                language=language,
                condition_on_previous_text=False,
                no_speech_threshold=0.5,
            )
            return (result.get("text") or "").strip()
        processor, model = self._torch_models[fast]
        inputs = processor(audio, sampling_rate=16000, return_tensors="pt")
        features = inputs.input_features.to(device=DEVICE, dtype=next(model.parameters()).dtype)
        generate = {"input_features": features}
        if language:
            generate["forced_decoder_ids"] = processor.get_decoder_prompt_ids(language=language, task="transcribe")
        with torch.no_grad():
            ids = model.generate(**generate)
        return processor.batch_decode(ids, skip_special_tokens=True)[0].strip()


app = FastAPI()
engine: Engine | None = None
transcriber: Transcriber | None = None
status = {"diffusion": "loading", "whisper": "loading"}
# Prompt and sliders can arrive while the model is still loading. Keep the latest and
# apply them before the engine is published, so the first frame already uses them.
pending_lock = threading.Lock()
pending_prompt: tuple[str, str | None] | None = None
pending_params: tuple | None = None


def _boot_engine() -> None:
    global engine
    eng = Engine()
    while True:
        with pending_lock:
            prompt, params = pending_prompt, pending_params
        if prompt is not None:
            eng.set_prompt(*prompt)
        if params is not None:
            eng.set_params(*params)
        with pending_lock:
            if pending_prompt == prompt and pending_params == params:
                engine = eng
                return


@app.on_event("startup")
async def startup() -> None:
    loop = asyncio.get_running_loop()

    async def load_engine():
        try:
            await loop.run_in_executor(gpu_pool, _boot_engine)
            status["diffusion"] = "ready"
            print("[engine] ready", flush=True)
        except Exception as e:  # surface the error in the UI
            status["diffusion"] = f"error: {e}"
            raise

    async def load_whisper():
        global transcriber
        try:
            transcriber = await loop.run_in_executor(stt_pool, Transcriber)
            status["whisper"] = "ready"
            print("[whisper] ready", flush=True)
        except Exception as e:
            status["whisper"] = f"error: {e}"
            raise

    asyncio.create_task(load_engine())
    asyncio.create_task(load_whisper())


@app.get("/health")
async def health():
    return {
        "ready": engine is not None,
        "status": status,
        "device": str(DEVICE),
        "model": MODEL_ID,
        "whisper": WHISPER_ID,
        "state": engine.state() if engine else None,
    }


@app.post("/transcribe")
async def transcribe(request: Request):
    if transcriber is None:
        return JSONResponse({"error": "whisper not ready", "status": status["whisper"]}, status_code=503)
    body = await request.body()
    audio = np.frombuffer(body, dtype="<f4").astype(np.float32)
    if audio.size < 1600:  # < 0.1 s
        return {"text": ""}
    fast = request.query_params.get("fast") == "1"
    t0 = time.time()
    text = await asyncio.get_running_loop().run_in_executor(stt_pool, transcriber.transcribe, audio, fast)
    return {"text": text, "seconds": round(time.time() - t0, 2)}


@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await websocket.accept()
    loop = asyncio.get_running_loop()
    await websocket.send_text(json.dumps({"type": "hello", **(engine.state() if engine else {})}))
    try:
        while True:
            msg = await websocket.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                if engine is None:
                    await websocket.send_text(json.dumps({"type": "loading", "status": status}))
                    continue
                t0 = time.time()
                out = await loop.run_in_executor(gpu_pool, engine.process, msg["bytes"])
                await websocket.send_bytes(out)
                await websocket.send_text(json.dumps({"type": "stats", "ms": round((time.time() - t0) * 1000)}))
            elif msg.get("text") is not None:
                data = json.loads(msg["text"])
                kind = data.get("type")
                eng = None
                if kind == "prompt":
                    item = (data.get("prompt", ""), data.get("style"))
                    with pending_lock:
                        pending_prompt = item
                        eng = engine
                    if eng is not None:
                        await loop.run_in_executor(gpu_pool, eng.set_prompt, item[0], item[1])
                elif kind == "params":
                    item = (data.get("strength"), data.get("steps"), data.get("seed"))
                    with pending_lock:
                        pending_params = item
                        eng = engine
                    if eng is not None:
                        await loop.run_in_executor(gpu_pool, eng.set_params, item[0], item[1], item[2])
                if engine is not None:
                    await websocket.send_text(json.dumps({"type": "state", **engine.state()}))
    except WebSocketDisconnect:
        pass


class AppFiles(StaticFiles):
    """The desktop window caches these files. Always send the copy on disk."""

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-store"
        return response


app.mount("/", AppFiles(directory=APP_DIR, html=True), name="app")

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
