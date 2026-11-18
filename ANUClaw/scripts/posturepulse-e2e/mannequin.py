"""SYNTHETIC mannequin renderer (not a person). Draws a front-facing standing figure with simple shading."""
import cv2, numpy as np
def frame(w=540, h=960, shift=0.0, tilt=0.0, seed=0):
    rng = np.random.default_rng(seed)
    img = np.full((h, w, 3), (205, 200, 195), np.uint8)
    cv2.rectangle(img, (0, int(h*0.88)), (w, h), (120, 125, 130), -1)           # floor
    img = cv2.GaussianBlur(img, (0, 0), 3)
    cx = w // 2 + int(shift)
    skin, shirt, pants, shoe = (150, 170, 215), (160, 90, 60), (90, 70, 55), (40, 40, 40)
    def P(x, y): return (int(cx + x), int(y))
    top = int(h*0.10)
    head_c = P(0, top + 55); 
    cv2.ellipse(img, head_c, (42, 54), 0, 0, 360, skin, -1)
    cv2.circle(img, P(-15, top+48), 5, (40,30,30), -1); cv2.circle(img, P(15, top+48), 5, (40,30,30), -1)   # eyes
    cv2.ellipse(img, P(0, top+75), (12, 5), 0, 0, 180, (80,60,120), 2)                                       # mouth
    cv2.ellipse(img, P(0, top+20), (44, 30), 0, 180, 360, (40, 30, 25), -1)                                   # hair
    cv2.rectangle(img, P(-14, top+105), P(14, top+140), skin, -1)                                             # neck
    sy = top + 150 + int(tilt)   # shoulder line (tilt shifts one side)
    ls, rs = P(-110, sy), P(110, sy - int(tilt*2))
    hip_y = top + 150 + 330
    lh, rh = P(-60, hip_y), P(60, hip_y)
    torso = np.array([ls, rs, rh, lh], np.int32); cv2.fillConvexPoly(img, torso, shirt)
    # arms
    for s, ex, wx in ((ls, -150, -165), (rs, 150, 165)):
        el = (s[0] + (ex - (-110 if ex < 0 else 110)), s[1] + 150)
        wr = (el[0] + (wx - ex), el[1] + 140)
        cv2.line(img, s, el, shirt, 38); cv2.line(img, el, wr, skin, 30); cv2.circle(img, wr, 20, skin, -1)
    # legs
    for h_, k_dx in ((lh, -70), (rh, 70)):
        kn = (h_[0] + (k_dx - h_[0] + cx), h_[1] + 250); an = (kn[0] + (8 if k_dx>0 else -8), kn[1] + 250)
        cv2.line(img, h_, kn, pants, 62); cv2.line(img, kn, an, pants, 52)
        cv2.ellipse(img, (an[0] + (14 if k_dx>0 else -14), an[1] + 20), (42, 20), 0, 0, 360, shoe, -1)
    noise = rng.normal(0, 3, img.shape); return np.clip(img + noise, 0, 255).astype(np.uint8)
