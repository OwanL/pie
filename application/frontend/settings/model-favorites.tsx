/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { createContext, type ComponentChildren } from 'preact';
import { useRef } from 'preact/hooks';
import { useIntendedSelection } from './optimistic-selection';

interface ModelFavoritesValue {
  favorites: readonly string[];
  onToggle: (spec: string) => void;
  disabled: boolean;
}

export const ModelFavoritesContext = createContext<ModelFavoritesValue>({
  favorites: [],
  onToggle: () => {},
  disabled: true,
});

/** One shared intent buffer for all pickers; persistence remains host-owned. */
export function ModelFavoritesProvider({
  favorites,
  onChange,
  disabled = false,
  children,
}: {
  favorites: readonly string[];
  onChange: (favorites: string[]) => void;
  disabled?: boolean;
  children: ComponentChildren;
}) {
  const selection = useIntendedSelection(favorites, onChange);
  const current = useRef(selection.value);
  current.current = selection.value;
  const onToggle = (spec: string) => {
    if (disabled) return;
    const next = current.current.includes(spec)
      ? current.current.filter((favorite) => favorite !== spec)
      : [...current.current, spec];
    // Read the latest intent even when multiple toggles precede a render.
    current.current = next;
    selection.update(next);
  };
  return (
    <ModelFavoritesContext.Provider value={{ favorites: selection.value, onToggle, disabled }}>
      {children}
    </ModelFavoritesContext.Provider>
  );
}
