"""
Exports SAM 2.1 Small (Meta, Apache 2.0) to ONNX for ImageSage's click to
select, and tests the result on sample images.

Export (needs Python with torch, github.com/vietanhdev/samexporter and its
pinned third_party/sam2, installed with SAM2_BUILD_CUDA=0):
  curl -L -o sam2.1_hiera_small.pt https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt
  python -m samexporter.export_sam2 --checkpoint sam2.1_hiera_small.pt \
    --output_encoder sam2.1-small-encoder.onnx --output_decoder sam2.1-small-decoder.onnx \
    --model_type sam2.1_hiera_small

Test: python export_sam2.py <encoder.onnx> <decoder.onnx> <out_dir>

Model contract (as exported):
  encoder  in  image [1,3,1024,1024] float: RGB resized to 1024x1024 (no padding),
                 /255, minus ImageNet mean, divided by ImageNet std
           out high_res_feats_0 [1,32,256,256], high_res_feats_1 [1,64,128,128],
               image_embed [1,256,64,64]
  decoder  in  the three encoder outputs; point_coords [1,N,2] in 1024 space;
               point_labels [1,N] (1 include, 0 exclude, -1 padding);
               mask_input [1,1,256,256]; has_mask_input [1]
           out masks [1,3,256,256] logits over the 1024x1024 square;
               iou_predictions [1,3]
"""

import hashlib
import os
import sys
import time

import numpy as np
import onnxruntime as ort
from PIL import Image

SIZE = 1024
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def encode(session, image):
    resized = np.asarray(image.resize((SIZE, SIZE), Image.BILINEAR), dtype=np.float32) / 255.0
    tensor = ((resized - MEAN) / STD).transpose(2, 0, 1)[None]
    return dict(zip(["high_res_feats_0", "high_res_feats_1", "image_embed"], session.run(None, {"image": tensor})))


def decode(session, features, image_size, points, mask_input=None):
    width, height = image_size
    coords = np.array([[[x / width * SIZE, y / height * SIZE] for x, y, _ in points]], dtype=np.float32)
    labels = np.array([[1.0 if include else 0.0 for _, _, include in points]], dtype=np.float32)
    has_mask = mask_input is not None
    masks, scores = session.run(None, {
        **features,
        "point_coords": coords,
        "point_labels": labels,
        "mask_input": mask_input if has_mask else np.zeros((1, 1, 256, 256), dtype=np.float32),
        "has_mask_input": np.array([1.0 if has_mask else 0.0], dtype=np.float32),
    })
    best = int(np.argmax(scores[0]))
    return masks[0, best], scores[0, best]


def to_image(logits, size):
    alpha = (1.0 / (1.0 + np.exp(-logits)) * 255).astype(np.uint8)
    return Image.fromarray(alpha).resize(size, Image.BILINEAR)


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for chunk in iter(lambda: file.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


if __name__ == "__main__":
    from skimage import data

    encoder_path, decoder_path, out_dir = sys.argv[1:4]
    for path in (encoder_path, decoder_path):
        print(f"{os.path.basename(path)}: {os.path.getsize(path)} bytes, sha256 {sha256(path)}")
    os.makedirs(out_dir, exist_ok=True)
    encoder = ort.InferenceSession(encoder_path, providers=["CPUExecutionProvider"])
    decoder = ort.InferenceSession(decoder_path, providers=["CPUExecutionProvider"])
    samples = {
        "rocket-sky": (data.rocket(), [(60, 40, True)]),
        "rocket-sky-minus": (data.rocket(), [(60, 40, True), (270, 200, False)]),
        "astronaut-flag": (data.astronaut(), [(40, 150, True)]),
        "coffee-cup": (data.coffee(), [(300, 120, True)]),
    }
    for name, (rgb, points) in samples.items():
        image = Image.fromarray(rgb).convert("RGB")
        started = time.perf_counter()
        features = encode(encoder, image)
        encoded = time.perf_counter()
        logits, score = decode(decoder, features, image.size, points)
        decoded = time.perf_counter()
        print(f"{name}: encode {encoded - started:.2f}s, decode {(decoded - encoded) * 1000:.0f}ms, score {score:.2f}, mask {logits.shape}")
        image.save(os.path.join(out_dir, f"{name}.png"))
        to_image(logits, image.size).save(os.path.join(out_dir, f"{name}-mask.png"))
