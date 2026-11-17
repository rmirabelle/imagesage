import { Keys, MenuPath, ShortcutList, Shot, Tip } from "../parts";

export function AiEditing() {
  return (
    <>
      <h1>Generate and edit with AI</h1>
      <p className="help-lead">
        Every AI request starts in the prompt bar and ends as a layer. This chapter covers GPT Image; the
        models that run on your own computer are in <i>Local models</i>.
      </p>

      <h2>The prompt bar</h2>
      <Shot name="prompt-controls" alt="The model list, the quality list, and the Generate and Regenerate buttons" />
      <p>
        Write the prompt in the box at the bottom of the window. The first list selects the model. The second
        selects the quality, and shows the estimated cost of the request at the current image size.
      </p>
      <p>
        <Keys k="Ctrl+Enter" /> sends the prompt as <b>Generate</b>, and <Keys k="Ctrl+Shift+Enter" /> sends
        it as <b>Regenerate</b>. Both shortcuts work while the prompt box has the focus.
      </p>

      <h2>Generate</h2>
      <p>
        On a blank image, <b>Generate</b> creates an image from the prompt alone. On any other image, it is
        an edit: Image Sage sends the image as it currently appears, with all visible layers combined, and
        GPT Image returns a complete new version. That version arrives as a new top layer.
      </p>
      <p>
        GPT Image always works on the whole picture. It receives no mask and no selection, so the prompt must
        name the part to change.
      </p>

      <h2>The inpainting workflow</h2>
      <p>
        The new layer contains the requested change, but also the small color differences that GPT Image
        introduces across the rest of the picture. Remove them as follows:
      </p>
      <ol>
        <li>Send the edit with <b>Generate</b>.</li>
        <li>Add a mask to the new layer. A new mask hides the whole layer.</li>
        <li>With the Mask tool, reveal only the area that was meant to change.</li>
      </ol>
      <p>
        Everything outside that area now comes from the layers below, unaltered. Repeat the cycle for each
        further edit; the image does not degrade. See <i>The Mask tool</i>.
      </p>

      <h2>Regenerate</h2>
      <p>
        <b>Regenerate</b> replaces the selected AI layer with a new result. Image Sage sends the layers below
        the selected layer, with the prompt that is now in the prompt box. The new result keeps the layer's
        name; its mask and adjustments are removed. Image Sage asks for confirmation first, and the notice
        that follows offers <b>Undo</b>.
      </p>
      <p>
        Regenerate is available for layers that GPT Image produced. It is not available for imported images,
        snapshots, or empty layers.
      </p>

      <h2>While a request runs</h2>
      <p>
        A running request appears as a row at the top of the Layers panel, with its stage, prompt, and
        elapsed time. You can continue to work, and select the row to watch its progress on the image.
      </p>
      <p>
        <b>Cancel</b> is available until OpenAI accepts the request, and incurs no charge. After that, the
        button reads <b>Abort</b>: it discards the result, but OpenAI still charges for it.
      </p>
      <p>
        GPT Image sends preview pictures while it works. <b>Capture</b> on a preview saves that preview as a
        layer of its own.
      </p>

      <h2>Image size</h2>
      <p>
        GPT Image accepts sides that are multiples of 16, a longest side of at most 3840 pixels, at most
        8,294,400 pixels in total, and proportions between 1:3 and 3:1. An image within those limits is sent
        unchanged. Any other image is sent at the nearest valid size and the result is scaled back, which
        softens it. An image beyond 3:1 cannot be sent.
      </p>

      <h2>Cost</h2>
      <Shot name="openai-status" alt="The OpenAI status in the title bar" />
      <p>
        Each completed request reports its actual charge, taken from OpenAI's usage data. The title bar shows
        the total for the current month, and each image tab shows the total for that image. Point at the
        title bar status for the total of the current day.
      </p>
      <p>
        These totals cover only requests made through Image Sage. Other use of the same API key is not
        counted.
      </p>
      <Tip>
        To see the regenerate confirmation again after <b>Don't show again</b>,
        open <MenuPath path="File > Settings > General" />.
      </Tip>

      <h2>Shortcuts</h2>
      <ShortcutList
        rows={[
          ["Ctrl+Enter", "Generate a new layer"],
          ["Ctrl+Shift+Enter", "Regenerate the selected layer"]
        ]}
      />
    </>
  );
}
