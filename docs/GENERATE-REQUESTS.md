# Image requests from another program

Another program on this computer, such as Chat Sage, can ask Image Sage for
images. Image Sage makes them with the local engine and the settings from
Settings → Local, saves them as PNG files, and exits. No window opens.

```
imagesage.exe --generate <request file>
```

The code is in `src-tauri/src/local.rs` (`run_file_request`). It runs before
the Tauri app is built, so the single-instance plugin does not send the
request to an open Image Sage.

## The request file

A JSON file. Only `prompt` and `outputFolder` are necessary.

| Field | Meaning | Default |
| --- | --- | --- |
| `prompt` | What the image shows. Image Sage adds the model's prompt start and negative prompt from the settings. | |
| `outputFolder` | Full path of the folder for the PNG files. Image Sage creates it. | |
| `count` | How many images, 1 to 50. Each image gets a new random seed. | 1 |
| `size` | Width and height, each a multiple of 16 from 256 to 4096. | `1024x1024` |
| `quality` | `low`, `medium`, or `high`. It sets the sampling steps. | `medium` |
| `model` | `chroma1-hd` or `qwen-image-2.1`. | `chroma1-hd` |

## The answer

Image Sage writes one JSON object on each line of standard output. The
program that starts Image Sage must give it a pipe for standard output.

```
{"event":"loading"}
{"event":"progress","image":1,"count":2,"step":5,"steps":30}
{"event":"image","image":1,"count":2,"path":"D:\\Out\\imagesage-1794330000-1.png"}
{"event":"done","paths":["D:\\Out\\imagesage-1794330000-1.png","D:\\Out\\imagesage-1794330000-2.png"]}
```

A failure ends with `{"event":"error","message":"..."}`. The exit code is 0
when every image was made, and 1 after an error.

## Rules for the caller

- Free the GPU memory first. The local model needs most of a 32 GB card, so
  the caller must unload its own model before the request.
- To cancel, end the Image Sage process. The engine stops with it.
- If an engine already runs (for example the Image Sage window has a model
  loaded), the request fails with an error, because two models do not fit in
  the GPU memory together.
