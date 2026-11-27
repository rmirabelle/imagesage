import { MenuPath, Shot, Tip } from "../parts";

export function LocalModels() {
  return (
    <>
      <h1>Local models</h1>
      <p className="help-lead">
        Image Sage can run open image and video models on your own graphics card. Local results cost nothing
        and need no internet connection once the engine and the model files are in place.
      </p>

      <h2>Requirements</h2>
      <p>
        Local models need an NVIDIA graphics card; 24 GB or more of graphics memory works best. Image Sage
        supplies the engine but not the models. It reads model files that you already have, for example in a
        ComfyUI installation, and does not copy or change them.
      </p>

      <h2>Install the engine</h2>
      <Shot name="settings-local-engine" alt="The Engine group of the Local settings" />
      <p>
        Open <MenuPath path="File > Settings > Local" />. <b>Download</b> installs the engine,
        stable-diffusion.cpp, from its GitHub project. The download is about 0.9 GB, occurs once, and is
        verified before use.
      </p>
      <p>
        The engine holds one model in graphics memory at a time. <b>Free memory after</b> sets how many idle
        minutes pass before the engine stops and releases that memory.
      </p>

      <h2>Select the model files</h2>
      <Shot name="settings-local-model" alt="The Chroma1-HD group of the Local settings" side="left" />
      <p>
        Each model has its own group. An image model needs three files: the <b>Diffusion model</b>,
        the <b>Text encoder</b>, and the <b>VAE</b>. Wan 2.2 needs a <b>Low-noise model</b> and
        a <b>High-noise model</b> in place of the single diffusion model.
      </p>
      <p>
        <b>Find in ComfyUI folder</b> locates the files in a ComfyUI installation and fills the
        rows. <b>Browse</b> sets one file by hand. <b>Load to check</b> loads the model once to confirm that
        the files work together.
      </p>
      <p>
        A model appears in the prompt bar only when all of its files are set.
      </p>

      <h2>What each model does</h2>
      <p>
        <b>Chroma1-HD</b> creates new images from a prompt. It does not see the existing image; its result is
        added as a new layer.
      </p>
      <p>
        <b>Qwen-Image-2.1</b> creates new images with <b>Generate</b>. With <b>Regenerate</b>, it edits the
        selected layer according to the prompt and adds the result as a new layer; the original layer
        remains. This applies to any layer, including an imported image.
      </p>
      <p>
        <b>Wan 2.2</b> produces short video clips. See <i>Animate a layer</i>.
      </p>

      <h2>Quality and size</h2>
      <p>
        For a local model, the quality list in the prompt bar sets the number of steps: 20, 30, or 40 for
        Chroma1-HD, and 16, 25, or 35 for Qwen-Image-2.1.
      </p>
      <p>
        A local model renders at about one megapixel, in the proportions of the image, and Image Sage scales
        the result to the image size. Results on a large image are therefore softer than those of GPT Image.
        Proportions beyond 4:1 are not supported.
      </p>

      <h2>Make a similar image</h2>
      <p>
        Each local image starts from random noise, so the same prompt gives a different image each time. The
        <i> seed</i> sets that noise, and Image Sage keeps the seed of each layer that a local model makes.
        Select such a layer and turn on <b>Same seed</b> in the prompt bar: the next image uses the seed of
        that layer. With the same prompt and model options, the result is the same image. A small change to
        the prompt or the LoRA gives an image close to the first.
      </p>
      <p>
        Layers made by earlier versions of Image Sage have no saved seed, so <b>Same seed</b> is not
        available for them.
      </p>

      <h2>Inspect a layer's settings</h2>
      <p>
        Each layer that a local model makes keeps every setting of its job: the positive prompt as sent
        (with the prompt start), the negative prompt, the seed, the sampler, the scheduler, the steps, the
        CFG scale, the resolution and aspect ratio, each LoRA with its strength, the model files and the
        engine release. Select the layer and open <MenuPath path="Edit > Inspect Layer" />, or right-click the
        layer and choose <b>Inspect</b>. <b>Copy Text</b> and <b>Copy JSON</b> put all of the settings on
        the clipboard. With the same model files and engine, these settings make the same image again.
      </p>
      <p>
        <b>Use These Settings</b> sets up the prompt bar to make the image again: it selects the model and
        puts the exact positive prompt in the prompt box. In place of the quality list, the prompt bar then
        shows <b>Saved settings</b> with the seed. The next local images use the saved model files, LoRAs,
        negative prompt, seed and sampling settings in place of those in Settings → Local; your own settings
        do not change. Change the prompt to make a close variation. Click <b>×</b> on the chip, or pick
        another model, to go back to your own settings.
      </p>
      <p>
        <MenuPath path="Edit > Use Settings From JSON" /> does the same with settings that Copy JSON made, for
        example in another document. Each model file and LoRA must be on this computer at the saved path.
        The saved size must have the shape of the image; for another shape, make a new image of that size first.
      </p>
      <p>
        GPT Image does not report a seed or its sampling settings, so for its layers the dialog shows the
        prompt, the model, the quality and the size only.
      </p>

      <h2>Model options</h2>
      <p>
        Each image model has a <b>Sampler</b> and a <b>Scheduler</b>, with the recommended scheduler marked.
        An optional <b>LoRA</b> file applies a style at an adjustable strength. <b>Prompt start</b> is placed
        before the prompt of each new image, and <b>Negative prompt</b> lists what to avoid.
      </p>
      <Tip>
        Changes are saved at once and apply to the next image or video.
      </Tip>
    </>
  );
}
