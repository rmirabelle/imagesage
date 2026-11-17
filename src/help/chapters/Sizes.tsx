import { MenuPath, Shot, Tip } from "../parts";

export function Sizes() {
  return (
    <>
      <h1>Image size and canvas size</h1>
      <p className="help-lead">
        Image Size scales the whole image. Canvas Size adds or removes space around it without scaling.
        Each is a single undo step.
      </p>

      <h2>Image Size</h2>
      <Shot name="image-size-dialog" alt="The Image Size dialog" />
      <p>
        <MenuPath path="Edit > Image Size" /> resamples every layer and every mask to the
        new <b>Width</b> and <b>Height</b>. Each field shows the new value as a percentage of the current size.
      </p>
      <p>
        <b>Keep proportions</b> is on by default: a change to one side sets the other. Turn it off to stretch
        the image. An enlarged image is lightly sharpened.
      </p>

      <h2>Canvas Size</h2>
      <Shot name="canvas-size-dialog" alt="The Canvas Size dialog with its Anchor grid" side="left" />
      <p>
        <MenuPath path="Edit > Canvas Size" /> changes the size of the canvas and leaves the pixels at their
        scale. New space is transparent.
      </p>
      <p>
        The <b>Anchor</b> grid sets where the existing image stays; space is added, or trimmed, on the
        opposite sides. Content outside a smaller canvas is removed.
      </p>

      <h2>Limits</h2>
      <p>
        The longest side of an image can be at most 8192 pixels. GPT Image accepts less: at most 3840 pixels
        per side and 8,294,400 pixels in total. An image above those limits is sent to GPT Image at a reduced
        size, and the result returns softer.
      </p>
      <Tip>
        Both commands are unavailable while Transform, a selection tool that waits for Apply, or a gradient
        is open. Apply or cancel that tool first.
      </Tip>

      <h2>Sizes for a new image</h2>
      <p>
        <MenuPath path="File > New Image" /> lists the sizes that GPT Image produces directly, from
        1024 × 1024 to 2560 × 1440. <b>Custom</b> accepts any size that GPT Image supports: both sides
        multiples of 16, a longest side of at most 3840 pixels, and proportions between 1:3 and 3:1.
      </p>
    </>
  );
}
