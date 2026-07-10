import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "../ThemeProvider";
import { ThinkingBlock } from "../ThinkingBlock";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: true,
      media: query,
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
});

describe("ThinkingBlock", () => {
  it("renders nothing for empty or whitespace-only content", () => {
    expect(renderToStaticMarkup(<ThinkingBlock content="" defaultExpanded />)).toBe("");
    expect(renderToStaticMarkup(<ThinkingBlock content={"  \n\t  "} defaultExpanded />)).toBe("");
  });

  it("renders immediately while streaming before the first text delta", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <ThinkingBlock content="" isStreaming />
      </ThemeProvider>,
    );
    expect(html).toContain("Thinking");
    expect(html).toContain("Working through the next step");
  });

  it("renders reasoning when content has visible text", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <ThinkingBlock content="real reasoning" defaultExpanded />
      </ThemeProvider>,
    );
    expect(html).toContain("Reasoning");
    expect(html).toContain("real reasoning");
  });
});
