import type { ComponentType } from "react";
import { Adjustments } from "./chapters/Adjustments";
import { AiEditing } from "./chapters/AiEditing";
import { Files } from "./chapters/Files";
import { GettingStarted } from "./chapters/GettingStarted";
import { Layers } from "./chapters/Layers";
import { LocalModels } from "./chapters/LocalModels";
import { Mask } from "./chapters/Mask";
import { PaintTool } from "./chapters/PaintTool";
import { Selections } from "./chapters/Selections";
import { Settings } from "./chapters/Settings";
import { Sizes } from "./chapters/Sizes";
import { Transform } from "./chapters/Transform";
import { AnimateLayer, Slideshow } from "./chapters/Video";

/** One help chapter: `id` is its address (`help_open` can select it), `title` shows in the list. */
export interface Chapter {
  id: string;
  title: string;
  body: ComponentType;
}

/** The help chapters, in reading order. */
export const CHAPTERS: Chapter[] = [
  { id: "getting-started", title: "Getting started", body: GettingStarted },
  { id: "ai-editing", title: "Generate and edit with AI", body: AiEditing },
  { id: "layers", title: "Layers", body: Layers },
  { id: "mask-tool", title: "The Mask tool", body: Mask },
  { id: "selections", title: "Selections", body: Selections },
  { id: "paint-tools", title: "The Paint tools", body: PaintTool },
  { id: "transform", title: "Transform", body: Transform },
  { id: "adjustments", title: "Adjustments", body: Adjustments },
  { id: "sizes", title: "Image size and canvas size", body: Sizes },
  { id: "files", title: "Open, save and export", body: Files },
  { id: "slideshow", title: "Video slideshow and layer videos", body: Slideshow },
  { id: "animate-layer", title: "Animate a layer", body: AnimateLayer },
  { id: "local-models", title: "Local models", body: LocalModels },
  { id: "settings", title: "Settings, updates and shortcuts", body: Settings }
];
