/** Help that a notice's "More info" link opens. */
export type HelpTopic = "no-subject";

export interface HelpContent {
  title: string;
  intro: string;
  sections: { heading: string; items: string[] }[];
}

export const HELP: Record<HelpTopic, HelpContent> = {
  "no-subject": {
    title: "No subject found",
    intro:
      "Auto-mask subject and Select subject look for one clear main object, such as a person, an animal or a product. The model found nothing it was sure was the subject.",
    sections: [
      {
        heading: "Why this happens",
        items: [
          "The searched area is mostly background: sky, ground, a wall or a texture, with no clear object.",
          "The object has almost the same colors as the area around it.",
          "The object is very small in the searched area.",
          "When the layer has a mask, only the area that the mask shows is searched, plus a small margin. A mask that shows mostly background, or that cuts off most of the object, can hide the subject."
        ]
      },
      {
        heading: "What to try",
        items: [
          "Paint the layer mask so it shows the whole object, with only a little background around it. Then try again.",
          "Turn off the layer mask to search the whole layer.",
          "Use Select subject on the toolbar to search the visible image.",
          "Paint the mask by hand with the Mask tool."
        ]
      }
    ]
  }
};
