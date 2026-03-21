---
name: video-frames
description: Extract frames or short clips from videos using ffmpeg.
homepage: https://ffmpeg.org
metadata:
  {
    "openclaw":
      {
        "emoji": "🎬",
        "requires": { "bins": ["ffmpeg"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "ffmpeg",
              "bins": ["ffmpeg"],
              "label": "Install ffmpeg (brew)",
            },
          ],
      },
  }
---

# Video Frames (ffmpeg)

Extract frames from videos for visual inspection.

## Output path (CRITICAL)

Save frames to `$HOME/.openclaw/media/inbound/` ONLY. The image tool REFUSES files from /tmp/.

In Docker: `$HOME` = `/data`, so the path is `/data/.openclaw/media/inbound/`.

## Usage

Single frame:

```bash
mkdir -p $HOME/.openclaw/media/inbound
bash {baseDir}/scripts/frame.sh /path/to/video.mp4 --out $HOME/.openclaw/media/inbound/frame.jpg
```

At a timestamp:

```bash
bash {baseDir}/scripts/frame.sh /path/to/video.mp4 --time 00:00:10 --out $HOME/.openclaw/media/inbound/frame-10s.jpg
```

Multiple frames (every N seconds):

```bash
mkdir -p $HOME/.openclaw/media/inbound
ffmpeg -i /path/to/video.mp4 -vf "fps=1/30" -q:v 2 $HOME/.openclaw/media/inbound/frame_%03d.jpg
```

## Viewing frames

After extracting, use the image tool:

```
image(images=["$HOME/.openclaw/media/inbound/frame_001.jpg"], prompt="Describe what you see")
```

## Notes

- Use `bash {baseDir}/scripts/frame.sh` (not `./{baseDir}/...`) because the script may lack +x permission.
- Use `$HOME/.openclaw/media/inbound/` not `~/.openclaw/` — tilde may not expand in all contexts.
- Prefer `--time` for specific moments. Use `.jpg` for quick share, `.png` for crisp UI frames.
- For long videos, extract every 30s rather than every frame.
