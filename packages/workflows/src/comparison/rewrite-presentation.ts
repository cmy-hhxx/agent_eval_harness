/** Display angle characters without seeding ASCII markup in Rewrite model material. */
export function rewritePresentation(text: string): string {
  return text.replaceAll("<", "＜").replaceAll(">", "＞");
}
