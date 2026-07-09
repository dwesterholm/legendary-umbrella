// Global vitest setup — extends `expect` with @testing-library/jest-dom's DOM
// matchers (toBeInTheDocument, toBeVisible, toBeDisabled, etc.) for the
// React-component test files introduced in Phase 8 Plan 4. Pure no-op for
// every non-DOM ("node" environment) test file — jest-dom's matchers are
// inert without a `document` global, and the existing action/lib tests never
// call them.
import "@testing-library/jest-dom/vitest";
