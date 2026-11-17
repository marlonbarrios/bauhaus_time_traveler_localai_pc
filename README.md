# Bauhaus Time Traveler

Part of the lecture performance *Born in Latent Space*. An interactive installation, and a section of that performance. A person stands in front of the camera and the piece renders them, live, as a Bauhaus time traveler: architectural goggles, solid geometry, Mondrian color, couture built like a mobile. The image is a speculative future, made in the room, in the moment.

What you say becomes the picture. The style of the work stays on from the first frame, so speech changes the scene without leaving the world of the piece. The picture sits in the center. The text can leave the screen. Sound and image can be recorded together as one video.

The rendering runs on this Mac. The camera image and the voice stay on the machine.

## The piece

- A live camera is transformed into a future figure, drawn in red, yellow, blue, black, and white.
- Spoken words, or words typed, steer the image. The Bauhaus style remains underneath them.
- `L` opens the listening. Key words replace the prompt as you talk, and the picture moves with them.
- `T` hides the text so the rendering can stand alone, the way it does in the room.
- `F` fills the screen.
- `P` plays the sound from the start. Press again to stop. The next press begins again.
- `R` records the picture and the sound together. `S` stops and saves the video.
- `C` shows or hides the camera preview. The camera keeps feeding the rendering either way.

## Run

Once:

```bash
./setup.sh
```

Then open the installation:

```bash
cd desktop && npm start
```

Or open `StreamCam.app` in this folder.

macOS asks once for the camera. In System Settings it is listed as "Electron", under Privacy & Security → Camera. The log is `server/server.log`.

In a browser: run `./start.sh`, then open http://127.0.0.1:7860

### Windows

On this PC the image runs on the NVIDIA GPU, and speech uses the CUDA Whisper builds instead of the Apple MLX models. From this folder, in PowerShell:

```powershell
./setup.ps1
cd desktop
npm start
```

Or, server only: `./start.ps1`, then open http://127.0.0.1:7860

Windows asks for the camera the first time the window opens. The log is `server/server.log`.

## Models

The model files are not in this repo. They are too large to upload. On the first launch the piece downloads them from Hugging Face into `models/` inside this folder, and uses them from there. You need a network connection that one time. After that, the rendering and the voice stay on the machine.

| Model | What it does | Where to get it | About |
|---|---|---|---|
| `stabilityai/sd-turbo` | The image. Turns the camera into the Bauhaus time traveler. | [huggingface.co/stabilityai/sd-turbo](https://huggingface.co/stabilityai/sd-turbo) | 4.8 GB |
| `madebyollin/taesd` | The small decoder that keeps the image fast enough to render live. | [huggingface.co/madebyollin/taesd](https://huggingface.co/madebyollin/taesd) | 9 MB |
| `mlx-community/whisper-large-v3-turbo` | Speech to text for Hold to talk and Hands-free. Mac only. | [huggingface.co/mlx-community/whisper-large-v3-turbo](https://huggingface.co/mlx-community/whisper-large-v3-turbo) | 1.5 GB |
| `mlx-community/whisper-small-mlx` | The faster speech model used while listening with `L`. Mac only. | [huggingface.co/mlx-community/whisper-small-mlx](https://huggingface.co/mlx-community/whisper-small-mlx) | 460 MB |
| `openai/whisper-large-v3-turbo` | The same speech model, built for this NVIDIA PC. | [huggingface.co/openai/whisper-large-v3-turbo](https://huggingface.co/openai/whisper-large-v3-turbo) | 1.6 GB |
| `openai/whisper-small` | The faster speech model on this PC. Optional. | [huggingface.co/openai/whisper-small](https://huggingface.co/openai/whisper-small) | 480 MB |

To fetch them by hand, from this folder, with the [Hugging Face Hub CLI](https://huggingface.co/docs/huggingface_hub/guides/cli):

```bash
pip install -U huggingface_hub
export HF_HOME="$PWD/models"
hf download stabilityai/sd-turbo
hf download madebyollin/taesd
hf download mlx-community/whisper-large-v3-turbo
hf download mlx-community/whisper-small-mlx
```

`models/` is ignored by git. Clone the repo, run the piece once, and the four models arrive on their own.

## Performing it

| Control | What it does |
|---|---|
| `R` and `S` | `R` records the rendered picture and the music as one video. `S` stops. Saved to `~/Movies/StreamCam`. Recording never starts on its own. |
| Prompt | `Enter` applies. "Live while typing" applies as you type. |
| Style | The world of the piece. Always added after the prompt, from the first frame, and remembered between launches. |
| `T` | Shows or hides the text, so the picture can sit alone in the center. |
| `C` | Shows or hides the camera preview. |
| Hold to talk | Speaks a prompt while the button is held. |
| Hands-free | Each sentence becomes the prompt when you pause. |
| Replace / Add | Spoken text replaces the prompt, or is added to it. |
| Transformation | Low stays close to the camera. High follows the prompt. |
| Quality | 1 step is faster. 2 steps carry more detail. |
| `P` | Plays the track from the beginning (default `app/media/bauhaus.mp3`). Press again to stop. Press again to start over. This is the sound inside the recording. |
| `L` | Starts listening. Key words you say replace the prompt, and the image changes with them. The style stays on. |
| `F` | Full screen. |

## Under the image

- **Image:** [StreamDiffusion](https://github.com/cumulo-autumn/StreamDiffusion) with `stabilityai/sd-turbo` and the `madebyollin/taesd` decoder, through the Apple-Silicon fork [StreamDiffusion-Mac](https://github.com/patrickhartono/StreamDiffusion-Mac).
- **Voice:** Whisper large-v3-turbo, locally, with MLX. Nothing is sent to the cloud.
- **Window:** the interface in `app/`, opened by Electron in `desktop/`.

```
server/server.py     the live loop: camera frame in, rendered frame out, plus speech
server/vendor/       StreamDiffusion-Mac
app/                 the installation interface
desktop/             the window
models/              the models, kept with the piece
```

Settings, if you need them:

- `SD_MODEL` (default `stabilityai/sd-turbo`)
- `WHISPER_MODEL` (default `mlx-community/whisper-large-v3-turbo`)
- `WHISPER_LANGUAGE` such as `en` or `es` (default: the piece detects it)
- `PORT` (default 7860)

StreamDiffusionV2 needs an NVIDIA GPU and does not run on this Mac. Here, StreamDiffusion and sd-turbo are what render the image in real time.
