/** Reading contract, independent of a fixture's literal IDs and scene placement.
 * This increment still serves synthetic content only; publication is a later task.
 */
export interface Story {
  readonly id: string;
  readonly title: string;
  readonly source: "synthetic-demo";
  readonly date: string;
  readonly introduction: string;
  readonly paragraphs: readonly string[];
  readonly image: {
    readonly src: string;
    readonly alt: string;
    readonly caption: string;
  };
  readonly closing: string;
}
