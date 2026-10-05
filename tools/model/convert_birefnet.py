"""
Converts the upstream BiRefNet general model to fp16 for ImageSage, and
compares the fp16 masks with the fp32 masks on sample images.

Source: https://github.com/ZhengPeng7/BiRefNet/releases/download/v1/BiRefNet-general-epoch_244.onnx
Needs: pip install onnx onnxruntime onnxconverter-common numpy pillow scikit-image

Usage: python convert_birefnet.py <input.onnx> <output.onnx> [compare_dir]
"""

import hashlib
import os
import sys

import numpy as np
import onnx
import onnxruntime as ort
from onnxconverter_common import float16
from PIL import Image

SIZE = 1024
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def convert(source, target):
    model = onnx.load(source)
    half = float16.convert_float_to_float16(model, keep_io_types=True)
    onnx.save(half, target)


def sample_images():
    from skimage import data

    return {
        "astronaut": data.astronaut(),
        "cat": data.chelsea(),
        "coffee": data.coffee(),
        "rocket": data.rocket(),
    }


def mask_of(session, rgb):
    image = Image.fromarray(rgb).convert("RGB")
    resized = np.asarray(image.resize((SIZE, SIZE), Image.BILINEAR), dtype=np.float32) / 255.0
    tensor = ((resized - MEAN) / STD).transpose(2, 0, 1)[None]
    logits = session.run(None, {"input_image": tensor})[0][0, 0]
    alpha = 1.0 / (1.0 + np.exp(-logits))
    return Image.fromarray((alpha * 255).round().astype(np.uint8)).resize(image.size, Image.BILINEAR)


def compare(full, half, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    providers = ["CPUExecutionProvider"]
    full_session = ort.InferenceSession(full, providers=providers)
    half_session = ort.InferenceSession(half, providers=providers)
    for name, rgb in sample_images().items():
        a = mask_of(full_session, rgb)
        b = mask_of(half_session, rgb)
        diff = np.abs(np.asarray(a, dtype=np.int16) - np.asarray(b, dtype=np.int16))
        print(f"{name}: mean diff {diff.mean():.3f}, max diff {diff.max()}, pixels off by >16: {(diff > 16).mean() * 100:.3f}%")
        Image.fromarray(rgb).save(os.path.join(out_dir, f"{name}.png"))
        a.save(os.path.join(out_dir, f"{name}-fp32.png"))
        b.save(os.path.join(out_dir, f"{name}-fp16.png"))


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for chunk in iter(lambda: file.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


if __name__ == "__main__":
    source, target = sys.argv[1], sys.argv[2]
    if not os.path.exists(target):
        convert(source, target)
    print(f"{target}: {os.path.getsize(target)} bytes, sha256 {sha256(target)}")
    if len(sys.argv) > 3:
        compare(source, target, sys.argv[3])
