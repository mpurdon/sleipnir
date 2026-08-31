/** The drawers a step can ask the app to open. Mirrors App's DrawerKind
 * discriminant; kept as its own union so the tour module does not depend
 * on App. */
export type TourDrawer = "projects" | "services" | "settings" | "org";

/**
 * One step of a guided tour.
 *
 * A step points at a real control by its `data-tour` attribute. Anchors are
 * deliberately optional and non-fatal: much of the app only exists in
 * certain states (there is no engaged-profile chip until something is
 * engaged), and a tour that dead-ends the first time a user runs it before
 * importing anything would be worse than useless. A step whose anchor is
 * absent falls back to a centred card, unless it sets `skipIfMissing`.
 */
export type TourStep = {
  /** Value of the target's `data-tour` attribute. */
  anchor?: string;
  title: string;
  /** One or two short sentences. Rendered as plain text. */
  body: string;
  /** Drawer that must be open for this step's anchor to exist. */
  drawer?: TourDrawer | null;
  /** Drop the step entirely when its anchor is missing, rather than
   * showing it as a centred card. For steps that only make sense while
   * pointing at something concrete. */
  skipIfMissing?: boolean;
};

export type Tour = {
  id: string;
  title: string;
  /** One line, shown in the help list. */
  blurb: string;
  /** Roughly how long it takes, shown in the help list. */
  length: string;
  steps: TourStep[];
};
