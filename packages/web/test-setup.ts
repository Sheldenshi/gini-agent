// Second test preload: runs after happydom.ts has registered the DOM, so React
// Testing Library's `screen` binds to a real `document`. Adds jest-dom matchers
// and unmounts/clears the DOM between tests so component state never bleeds.
import { afterEach } from "bun:test";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});
