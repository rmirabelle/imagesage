import { MenuPath, Shot, Tip } from "../parts";

export function Slideshow() {
  return (
    <>
      <h1>Video slideshow and layer videos</h1>
      <p className="help-lead">
        A slideshow turns the layers of an image into an MP4 video that shows how the image was built.
        Layer videos animate every layer with Wan 2.2.
      </p>

      <h2>Export a video slideshow</h2>
      <Shot name="slideshow-dialog" alt="The Export video slideshow dialog" />
      <p>
        <MenuPath path="File > Export Video Slideshow" /> makes one picture from the original image and one
        from each visible layer, from the bottom up. Hidden layers are left out.
      </p>
      <p>
        <b>Style</b> sets the presentation. <b>Story</b> opens on the final image with a title box, then
        shows the original and each layer with its name, and ends on the final image. <b>Standard</b> shows
        each picture once, with crossfades and no text.
      </p>
      <p>
        <b>Shape</b> keeps the proportions of the image, within 1920 × 1080, or produces a vertical 9:16
        video with a blurred background. <b>Seconds per layer</b> sets the pace; the resulting length of the
        video is shown beside it.
      </p>
      <p>
        <b>Make video</b> encodes the video, at 30 frames per second, and then asks where to save it. The
        notice that follows offers <b>Play</b>.
      </p>

      <h2>Music</h2>
      <p>
        <b>Music</b> offers five included tracks, or a file of your own. An included track is downloaded once,
        on first use. The waveform shows the part of the track that plays: drag the frame to select another
        part, and select <b>Play</b> to hear it.
      </p>
      <p>
        The music fades in at the start and fades out with the picture at the end. Image Sage remembers the
        track and its position for each image.
      </p>

      <h2>Export layer videos</h2>
      <p>
        <MenuPath path="File > Export Layer Videos" /> asks for a folder and makes three five-second clips
        from each layer, hidden layers included. Each clip starts from the layer's picture and uses the
        layer's prompt. The clips are WebM files, named after the image, the layer number, and the clip
        number.
      </p>
      <p>
        A bar below the tabs shows the progress. You can continue to work while the clips are
        made. <b>Cancel</b> stops the run and keeps the clips that are complete.
      </p>
      <Tip>
        Layer videos need the Wan 2.2 image-to-video files; see <i>Local models</i>. An image wider or taller
        than 3:1 cannot be animated.
      </Tip>
    </>
  );
}

export function AnimateLayer() {
  return (
    <>
      <h1>Animate a layer</h1>
      <p className="help-lead">
        Animate Layer makes a short video clip from one layer with Wan 2.2, on your own computer. The clip
        opens in a separate window, and the image itself does not change.
      </p>

      <h2>Start a clip</h2>
      <p>
        Select a layer and open <MenuPath path="Edit > Animate Layer" />, or right-click the layer and
        choose <b>Make Video</b>. The video window opens with the layer's picture and prompt. Only the
        selected layer is sent; transparent areas become black.
      </p>
      <p>
        In <b>Prompt</b>, describe what happens in the clip and how the camera moves.
      </p>

      <h2>Options</h2>
      <p>
        <b>Start</b> selects the model. <b>From the layer's picture</b> uses the layer as the first frame of
        the clip. <b>From the prompt alone</b> ignores the picture; the layer supplies only the proportions
        and the initial prompt.
      </p>
      <p>
        <b>Size</b> is <b>Small</b>, up to 832 × 480, or <b>Large</b>, up to 1280 × 720, in the proportions of
        the layer. <b>Length</b> is 2, 3, or 5 seconds, at 16 frames per second.
      </p>

      <h2>Make and save the clip</h2>
      <p>
        <b>Make video</b> starts the model. The window shows the stage, the elapsed time, and a preview. A
        large or long clip can take many minutes. <b>Cancel</b> stops the run.
      </p>
      <p>
        The finished clip plays in a loop. <b>Save</b> writes it as a WebM file. <b>Make again</b> produces a
        new clip with the current settings and replaces the previous one.
      </p>
      <Tip>
        A clip exists only in memory until you save it. Image Sage asks before the window closes with an
        unsaved clip.
      </Tip>

      <h2>Requirements</h2>
      <p>
        The local engine and the Wan 2.2 files must be set
        in <MenuPath path="File > Settings > Local" />; see <i>Local models</i>. A layer wider or taller than
        3:1 cannot be animated.
      </p>
    </>
  );
}
