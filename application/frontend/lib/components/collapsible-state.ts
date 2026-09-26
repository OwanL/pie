export function syncCollapsibleOpenState(
  currentOpen: boolean,
  previousDefaultOpen: boolean,
  nextDefaultOpen: boolean,
): boolean {
  return nextDefaultOpen !== previousDefaultOpen ? nextDefaultOpen : currentOpen;
}
