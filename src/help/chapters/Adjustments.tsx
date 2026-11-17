import { Keys, Shot, Tip } from "../parts";

export function Adjustments() {
  return (
    <>
      <h1>Adjustments</h1>
      <p className="help-lead">
        An adjustment changes how one layer looks without changing its pixels. It can be edited, turned off,
        or removed at any time.
      </p>

      <h2>Add an adjustment</h2>
      <Shot name="adjust-add-menu" alt="The Add Layer Adjustment menu" />
      <p>
        Select <b>+ Adjustment</b> below the layer name and choose the kind. Its controls open at once, and
        the image updates as you move a slider.
      </p>
      <p>
        A layer can hold several adjustments, including more than one of a kind. They are applied in the
        order shown, from left to right, and affect only their own layer.
      </p>

      <h2>The kinds</h2>
      <Shot name="adjust-contrast" alt="The controls of a Contrast adjustment" side="left" />
      <p>
        <b>Brightness</b> lightens or darkens the layer.
      </p>
      <p>
        <b>Contrast</b> has four controls. <b>Amount</b> sets the strength. <b>Middle</b> sets the tone
        around which contrast turns. <b>Soft ends</b> protects the darkest and lightest tones. <b>Color</b> sets
        how far the change extends to color saturation.
      </p>
      <p>
        <b>Hue/Saturation</b> shifts hue, saturation, and lightness. With <b>Colorize</b>, it tints the whole
        layer with one hue.
      </p>
      <p>
        <b>Opacity</b> makes the layer partly transparent.
      </p>
      <p>
        <b>Blur</b> softens the layer by a radius of up to 300 pixels. With <b>Motion</b>, it blurs along one
        direction, set by <b>Distance</b> and <b>Angle</b>.
      </p>
      <p>
        <b>Sharpen</b> has an <b>Amount</b> and a <b>Radius</b>. <b>Brightness only</b>, on by default,
        sharpens detail without color fringes.
      </p>

      <h2>Edit an adjustment</h2>
      <Shot name="adjust-chips" alt="A layer with two adjustments" />
      <p>
        Each adjustment appears as a chip with its current values. Select a chip to open its controls.
        Double-click a slider to return it to its neutral value.
      </p>
      <Shot name="adjust-chip-menu" alt="The menu of an adjustment" side="left" />
      <p>
        <Keys k="Ctrl+Click" /> turns a chip off or on, so that you can compare the layer with and without
        it. Right-click a chip to reset, rename, duplicate, or delete the adjustment. A renamed chip shows
        its label in place of its values.
      </p>
      <p>
        The button at the left of the strip turns all adjustments of the layer off or on together.
      </p>

      <h2>Limit an adjustment with a mask</h2>
      <p>
        The small <b>+</b> on a chip adds a mask to that adjustment. The adjustment then applies only where
        the mask shows it, which allows, for example, a blur of the background alone. The mask is painted
        with the Mask tool, in the same way as a layer mask.
      </p>
      <Tip>
        Adjustments are saved in the document and remain editable. <b>Export Image</b> applies them to the
        exported picture.
      </Tip>
    </>
  );
}
