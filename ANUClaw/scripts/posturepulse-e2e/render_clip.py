"""Render a SYNTHETIC mannequin clip + ClipCapture sidecar for the PosturePulse pipeline test.

The figure is a drawn mannequin, NOT a person. This clip establishes that the pipeline runs (decode -> real pose model ->
quality gate -> metrics -> report). It says NOTHING about accuracy on real people. Run with the ml-service venv python
(needs numpy, opencv, av). Usage: render_clip.py OUT_DIR [shoulder_tilt_px] [frames]
"""
import json, sys, datetime, pathlib
import av, cv2, numpy as np
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from mannequin import frame

out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
tilt = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0
n = int(sys.argv[3]) if len(sys.argv) > 3 else 60
W, H, FPS = 540, 960, 30
W0, H0 = 730, 1300   # the figure is drawn larger and scaled down so the WHOLE body (head to feet) is inside the picture
with av.open(str(out / "clip.mov"), "w", format="mov") as c:
    s = c.add_stream("libx264", rate=FPS); s.width, s.height, s.pix_fmt = W, H, "yuv420p"
    for i in range(n):
        sway = 2.0 * np.sin(i / 9.0)                       # small deterministic sway so the clip is not a still
        img = cv2.resize(frame(W0, H0, shift=sway * 1.35, tilt=tilt * 1.35, seed=i), (W, H), interpolation=cv2.INTER_AREA)
        f = av.VideoFrame.from_ndarray(img[:, :, ::-1], format="rgb24"); f.pts = i
        for p in s.encode(f): c.mux(p)
    for p in s.encode(): c.mux(p)
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
side = {
    "clipId": "SYNTHETIC-MANNEQUIN-CLIP-001", "sessionId": "", "stepId": "static.anterior", "view": "anterior",
    "recordedAt": now, "nominalFps": float(FPS), "width": W, "height": H,
    "frames": [{"index": i, "t": i / FPS, "gravity": [0.0, 1.0, 0.0]} for i in range(n)],
    "device": {"model": "SYNTHETIC-RENDERER (not a device)", "lens": "back_wide", "appVersion": "synthetic"},
    "provenance": {"schemaVersion": "clip-capture/v0", "modelVersion": "synthetic-mannequin/1", "calibrationVersion": "none/v0", "producedAt": now},
}
(out / "sidecar.json").write_text(json.dumps(side))
print(json.dumps({"video": str(out / "clip.mov"), "frames": n, "shoulderTiltPx": tilt}))
