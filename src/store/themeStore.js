"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { THEME_CONFIG } from "@/shared/constants/config";

const APPEARANCES = new Set(["default", "liquid", "atelier", "forge", "macbook"]);

const useThemeStore = create(
  persist(
    (set, get) => ({
      theme: THEME_CONFIG.defaultTheme,
      appearance: THEME_CONFIG.defaultAppearance,

      setTheme: (theme) => {
        set({ theme });
        applyTheme(theme, get().appearance);
      },

      setAppearance: (appearance) => {
        const next = APPEARANCES.has(appearance)
          ? appearance
          : THEME_CONFIG.defaultAppearance;
        set({ appearance: next });
        applyTheme(get().theme, next);
      },

      toggleTheme: () => {
        const currentTheme = get().theme;
        const newTheme = currentTheme === "dark" ? "light" : "dark";
        set({ theme: newTheme });
        applyTheme(newTheme, get().appearance);
      },

      initTheme: () => {
        const { theme, appearance } = get();
        applyTheme(theme, appearance);
      },
    }),
    {
      name: THEME_CONFIG.storageKey,
      // ponytail: single persist key; appearance rides along with light/dark
      partialize: (state) => ({
        theme: state.theme,
        appearance: state.appearance,
      }),
      merge: (persisted, current) => {
        const p = persisted && typeof persisted === "object" ? persisted : {};
        return {
          ...current,
          ...p,
          appearance: APPEARANCES.has(p.appearance)
            ? p.appearance
            : THEME_CONFIG.defaultAppearance,
        };
      },
    }
  )
);

function applyTheme(theme, appearance) {
  if (typeof window === "undefined") return;

  const root = document.documentElement;
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";

  const effectiveTheme = theme === "system" ? systemTheme : theme;

  if (effectiveTheme === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }

  const next = APPEARANCES.has(appearance)
    ? appearance
    : THEME_CONFIG.defaultAppearance;

  if (next === "default") {
    root.removeAttribute("data-appearance");
  } else {
    root.setAttribute("data-appearance", next);
  }
}

export default useThemeStore;
