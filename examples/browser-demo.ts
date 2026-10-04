import { findBrowserExecutable } from '../src/browser/browser-executable.ts';
import { BrowserRuntime } from '../src/browser/browser-runtime.ts';

const runtime = new BrowserRuntime({
  executablePath: await findBrowserExecutable(),
});

try {
  const firstPage = await runtime.start();
  await firstPage.setContent(`
    <title>Persistent browser demo</title>
    <button id="counter">0</button>
    <script>
      counter.addEventListener("click", () => {
        counter.textContent = String(Number(counter.textContent) + 1);
      });
    </script>
  `);
  await firstPage.locator('#counter').click();

  const secondPage = await runtime.start();
  const counter = await secondPage.locator('#counter').textContent();

  console.log({
    counter,
    samePage: firstPage === secondPage,
    title: await secondPage.title(),
  });
} finally {
  await runtime.close();
}
