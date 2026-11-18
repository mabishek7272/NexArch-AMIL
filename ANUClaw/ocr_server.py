"""
Local PaddleOCR service for ANUClaw (plan F06).

Contract (consumed by src/documents/ocr.ts):
  POST /ocr  multipart field "file" (PNG/JPEG page image)
    200 {"lines": [{"text", "confidence", "bbox"}], "engine_version": "..."}
    400 unsupported/empty upload · 413 too large · 500 OCR failure · 503 engine not loaded
  GET /health -> {"status": "ok", "engine_version": "..."}

Supports PaddleOCR 3.x (predict() -> rec_texts/rec_scores/rec_polys; pins in
requirements-ocr3.txt — used on macOS arm64 where paddle 2.6.2 inference hangs) and
2.x (ocr(path, cls=True); pins in requirements-ocr.txt), chosen by major version.

STATUS: UNVERIFIED in this checkout — PaddleOCR/Paddle were not installed in the
scan environment, so this file has not been executed. Verify in the pinned
environment before relying on it. Accuracy must be measured (plan §7.2).
Binds to 127.0.0.1 only. Temp files are written to a private temp directory and
always removed. Never log document text.
"""
import os
import tempfile

import uvicorn
from fastapi import FastAPI, File, HTTPException, UploadFile

MAX_BYTES = int(os.environ.get("OCR_MAX_BYTES", str(20 * 1024 * 1024)))
ALLOWED = {"image/png": ".png", "image/jpeg": ".jpg"}

app = FastAPI()
_engine = None
_engine_version = "unknown"
_engine_error = None

try:
    import paddleocr  # type: ignore
    from paddleocr import PaddleOCR  # type: ignore

    _ver = getattr(paddleocr, "__version__", "0")
    _engine_version = f"paddleocr-{_ver}"
    _MAJOR = int(str(_ver).split(".")[0] or 0)
    if _MAJOR >= 3:
        # PaddleOCR 3.x API (used on platforms where paddle 2.6 inference hangs).
        _engine = PaddleOCR(lang=os.environ.get("OCR_LANG", "en"), use_doc_orientation_classify=False,
                            use_doc_unwarping=False, use_textline_orientation=False)
    else:
        _engine = PaddleOCR(use_angle_cls=True, lang=os.environ.get("OCR_LANG", "en"), show_log=False)
except Exception as exc:  # engine unavailable -> 503, never a fake result
    _engine_error = type(exc).__name__


@app.get("/health")
def health():
    if _engine is None:
        raise HTTPException(status_code=503, detail=f"OCR engine not loaded ({_engine_error})")
    return {"status": "ok", "engine_version": _engine_version}


@app.post("/ocr")
async def process_ocr(file: UploadFile = File(...)):
    if _engine is None:
        raise HTTPException(status_code=503, detail="OCR engine not loaded")
    suffix = ALLOWED.get(file.content_type or "")
    if suffix is None:
        raise HTTPException(status_code=400, detail="Only PNG or JPEG page images are accepted")
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Empty upload")
    if len(contents) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="Upload too large")

    fd, tmp_path = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(contents)
        lines = []
        if _MAJOR >= 3:
            for res in _engine.predict(tmp_path) or []:
                texts, scores, polys = res["rec_texts"], res["rec_scores"], res["rec_polys"]
                for text, conf, poly in zip(texts, scores, polys):
                    lines.append({"text": str(text), "confidence": float(conf), "bbox": [[float(x), float(y)] for x, y in poly]})
        else:
            for page in _engine.ocr(tmp_path, cls=True) or []:
                for item in page or []:
                    bbox, (text, conf) = item[0], item[1]
                    lines.append({"text": str(text), "confidence": float(conf), "bbox": [[float(x), float(y)] for x, y in bbox]})
        return {"lines": lines, "engine_version": _engine_version}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"OCR failed ({type(exc).__name__})")
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("OCR_PORT", "4001")))
