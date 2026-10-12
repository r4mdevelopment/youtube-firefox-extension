These media fixtures were generated locally from FFmpeg lavfi testsrc and sine generators. No third-party video/audio content was used. The generated media is dedicated to the public domain (CC0-1.0).

Commands (fixture generation only, development dependency):

```
ffmpeg -f lavfi -i testsrc=size=32x32:rate=10 -t 1 -an -c:v libx264 -bf 2 -pix_fmt yuv420p -movflags +faststart video-only.mp4
ffmpeg -f lavfi -i sine=frequency=440:sample_rate=48000 -t 1 -vn -c:a aac audio-only.mp4
ffmpeg -f lavfi -i testsrc=size=32x32:rate=10 -t 1 -an -c:v libvpx-vp9 unsupported.webm
```

The extension package contains no FFmpeg executable. Only Mediabunny is bundled for remuxing. JSON fixtures are synthetic, with illustrative googlevideo URLs, not recorded working signed URLs.

`background-video.mp4` and `background-audio.mp4` are 20-second generated solid-blue/sine fixtures, also CC0-1.0.
