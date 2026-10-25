import { useDisclosureMotion } from '../../lib/components/use-disclosure-motion';

export function useToolDisclosureMotion(open: boolean, enabled: boolean) {
  return useDisclosureMotion(open, enabled);
}
