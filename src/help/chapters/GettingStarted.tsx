import { Keys, MenuPath, Shot, Tip } from "../parts";

export function GettingStarted() {
  return (
    <>
      <h1>Getting started</h1>
      <p className="help-lead">
        Image Sage is a focused, layer-based editor for generating and editing images with OpenAI GPT Image,
        and with Chroma1-HD, Qwen-Image and Wan 2.2 on your own computer.
      </p>

      <h2>Why Image Sage exists</h2>
      <p>
        Image Sage was designed to solve one specific problem: <b>inpainting</b>, the editing of one part of
        an existing image.
      </p>
      <p>
        No current AI image generator does this well. The frontier model, GPT Image 2.6, can modify an
        existing image with excellent results, but it recreates the entire image and merges its edit into
        the copy. The areas that it did not edit are not exact duplicates of the original. Small amounts of
        color noise appear in them, and the noise increases with every edit. GPT can inpaint, but the process
        is highly lossy.
      </p>
      <p>
        Image Sage removes that loss. Each GPT edit arrives as a new layer above the original. You then mask
        out the areas of that layer that were not meant to change, so the untouched original shows through.
        You can edit the same image any number of times with no perceptible loss of quality.
      </p>
      <p>
        Since then, Image Sage has gained a set of photo editing and video tools, and more are added as the
        need arises.
      </p>

      <h2>Connect OpenAI</h2>
      <Shot name="settings-openai" alt="The OpenAI section of the Settings dialog" />
      <p>
        GPT Image runs on OpenAI's servers and is billed to your OpenAI account for each image, so Image Sage
        needs an API key. Open <MenuPath path="File > Settings" />, paste the key, and select <b>Save key</b>.
        Image Sage tests the key before it stores it.
      </p>
      <p>
        The key is stored in Windows Credential Manager. Once the key is accepted, the title bar
        shows <Shot name="openai-status" alt="The OpenAI status in the title bar" side="inline" />, followed by
        the amount charged through Image Sage in the current month.
      </p>
      <Tip>
        An API key is not required for local models. Chroma1-HD and Qwen-Image generate images on your own
        graphics card at no cost. See <i>Local models</i>.
      </Tip>

      <h2>Create an image</h2>
      <Shot name="start-buttons" alt="The New Image and Open image buttons" />
      <p>
        With no image open, Image Sage offers two starting points. <b>Open image</b> loads a PNG or JPEG
        file, or an Image Sage document. <b>New Image</b> creates a blank image at the size you select.
        Both commands are also in the <b>File</b> menu.
      </p>
      <Shot name="new-image-dialog" alt="The New Image dialog" side="left" />
      <p>
        The <b>New Image</b> dialog lists the sizes that GPT Image supports, and <b>Custom</b> for any other
        width and height. Select <b>OK</b> to open the blank image in a new tab.
      </p>
      <p>
        A blank image has no content until you generate a layer from a prompt, or add an empty layer and paint.
      </p>

      <h2>Generate a layer</h2>
      <Shot name="prompt-controls" alt="The model list, the quality list, and the Generate and Regenerate buttons" />
      <p>
        The prompt bar is at the bottom of the window. Describe the image, or the change that you want, select
        the model and the quality, and select <b>Generate</b>, or press <Keys k="Ctrl+Enter" />. The result arrives as
        a new layer, so the layers below it stay intact.
      </p>
      <p>
        <b>Regenerate</b>, or <Keys k="Ctrl+Shift+Enter" />, runs the prompt again for the selected layer.
      </p>

      <h2>The workspace</h2>
      <Shot name="window-overview" alt="The Image Sage window with an image open" side="block" />
      <p>
        Each open image has a tab below the menu bar. The <b>toolbar</b> holds the selection and paint tools
        and the paint color. The <b>work area</b> shows the image, with the shortcuts for the current tool
        below it. The <b>Layers</b> panel at the right lists the layers, newest first. The <b>prompt bar</b> is
        at the bottom.
      </p>
      <p>
        To pan, hold <Keys k="Space" /> and drag. To zoom around the pointer, hold <Keys k="Ctrl" /> and turn
        the mouse wheel.
      </p>
    </>
  );
}
