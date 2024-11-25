const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const net = require('net');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

// Add stealth plugin to puppeteer
puppeteer.use(StealthPlugin());

// Function to generate a valid directory name based on the URL
function generateDirectoryName(url) {
  return url.replace(/https?:\/\//, '').replace(/[^\w]/g, '_');
}

// Function to generate a valid file name based on the page sequence
function generateFileName(index) {
  return `page_${index}.png`;
}

// Function to overlay click position on the image using sharp
async function overlayClickPosition(inputImagePath, outputImagePath, x, y) {
  const marker = Buffer.from(`
    <svg width="20" height="20">
      <circle cx="10" cy="10" r="10" fill="red" />
    </svg>
  `);

  try {
    const tempImagePath = outputImagePath + '_temp.png';

    await sharp(inputImagePath)
      .composite([{ input: marker, left: x - 10, top: y - 10 }])
      .toFile(tempImagePath);

    fs.renameSync(tempImagePath, outputImagePath);
    console.log(`Updated screenshot saved with click overlay at: ${outputImagePath}`);
  } catch (error) {
    console.error('Error overlaying click position on screenshot:', error);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function selectFirstOption(page) {
  const selectElements = await page.$$('select');

  for (let select of selectElements) {
    try {
      await page.evaluate((element) => element.scrollIntoView(), select);
      await sleep(Math.floor(Math.random() * 500) + 500); // Random delay after scrolling

      const isVisible = await page.evaluate((element) => {
        const style = window.getComputedStyle(element);
        return style && style.visibility !== 'hidden' && style.display !== 'none';
      }, select);

      const isDisabled = await page.evaluate((element) => element.hasAttribute('disabled'), select);

      if (isVisible && !isDisabled) {
        const selectedValue = await page.evaluate((select) => {
          select.selectedIndex = 1;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return select.options[select.selectedIndex].value;
        }, select);
        console.log(`Selected first value for select box: ${selectedValue}`);
      } else {
        console.log('Skipping non-interactable select element.');
      }
    } catch (e) {
      console.log('Skipping select element due to timeout or other error:', e.message);
    }
  }

  await sleep(1000);
}

async function fillInputFields(page) {
  const inputElements = await page.$$('input');

  for (let input of inputElements) {
    try {
      await page.evaluate((element) => element.scrollIntoView(), input);
      await sleep(Math.floor(Math.random() * 500) + 500); // Random delay after scrolling

      const isVisible = await page.evaluate((element) => {
        const style = window.getComputedStyle(element);
        return style && style.visibility !== 'hidden' && style.display !== 'none';
      }, input);

      const isReadOnly = await page.evaluate((element) => element.hasAttribute('readonly'), input);
      const isDisabled = await page.evaluate((element) => element.hasAttribute('disabled'), input);

      if (isVisible && !isReadOnly && !isDisabled) {
        await Promise.race([
          input.type('aa', { delay: 100 }),
          new Promise((_, reject) => setTimeout(() => reject('Timeout'), 3000)),
        ]);
        console.log('Successfully filled input field');
      } else {
        console.log('Skipping non-interactable input field.');
      }
    } catch (e) {
      console.log('Skipping input field due to timeout or other error:', e.message);
    }
  }

  await page.evaluate(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  await sleep(Math.floor(Math.random() * 500) + 500); // Random delay after scrolling to top

  await sleep(1000);
}

// Function to take screenshot and connect to socket
async function runCrawler(url) {
  const actions = []; // To store the action history
  const HOST = 'localhost';
  const PORT = 5000;

  let client;

  try {
    // Start socket connection
    client = new net.Socket();
    await new Promise((resolve, reject) => {
      client.connect(PORT, HOST, () => {
        console.log('Connected to socket server');
        resolve();
      });

      client.on('error', (err) => {
        console.error('Socket error:', err);
        reject(err);
      });
    });

    const browser = await puppeteer.launch({
      headless: true, // Consider not running headless to avoid detection
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--start-fullscreen',
        '--disable-blink-features=AutomationControlled', // Hide automation features
      ],
    });
    let page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/102.0.0.0 Safari/537.36'); // Set User-Agent
    await page.setViewport({ width: 1280, height: 800 }); // Set a realistic viewport size
    await page.evaluateOnNewDocument(() => {
      delete navigator.__proto__.webdriver;
    }); // Remove webdriver property to avoid detection

    await page.setDefaultNavigationTimeout(60000);

    const screenshotFlowsDir = path.join(__dirname, 'screenshot_flows');
    if (!fs.existsSync(screenshotFlowsDir)) {
      fs.mkdirSync(screenshotFlowsDir);
    }

    const sanitizedDirName = generateDirectoryName(url);
    const urlDir = path.join(screenshotFlowsDir, sanitizedDirName);
    if (!fs.existsSync(urlDir)) {
      fs.mkdirSync(urlDir);
    }

    const outputJSONPath = path.join(urlDir, 'click_actions.json');

    let screenshotIndex = 1;

    await page.goto(url, { waitUntil: 'load' });
    await sleep(Math.floor(Math.random() * 2000) + 1000); // Random delay after page load

    const takeScreenshot = async () => {
      const screenshotPath = path.join(urlDir, generateFileName(screenshotIndex));
      await page.screenshot({ path: screenshotPath });
      console.log(`Screenshot saved to: ${screenshotPath}`);
      const currentUrl = await page.url();
      screenshotIndex++;
      return { screenshotPath, currentUrl };
    };

    await selectFirstOption(page);
    await fillInputFields(page);

    let { screenshotPath, currentUrl } = await takeScreenshot();

    let previousElementHTML = null;

    while (true) {
      // Send screenshot path to the server
      client.write(`${screenshotPath}\n`);

      // Wait for response
      let clickPosition = await new Promise((resolve, reject) => {
        client.once('data', (data) => {
          console.log(`Received from server: ${data}`);
          resolve(data.toString().trim());
        });
      });

      const match = clickPosition.match(/Click Point:\s*(\d+),\s*(\d+)/);
      if (clickPosition === 'No login button detected') {
        console.log('No login button detected');
        break;
      }
      else if (!match) {
        console.error(`Invalid data received from socket: ${clickPosition}`);
        throw new Error(`Invalid click position: ${clickPosition}`);
      }

      const [x, y] = match.slice(1).map(Number);

      const currentElementHTML = await page.evaluate(({ x, y }) => {
        const element = document.elementFromPoint(x, y);
        return element ? element.outerHTML : null;
      }, { x, y });

      if (currentElementHTML === null) {
        console.log('No element found at the click position.');
        break;
      }

      if (currentElementHTML === previousElementHTML) {
        console.log('Click position points to the same element. Exiting crawler...');
        break;
      }

      previousElementHTML = currentElementHTML;

      actions.push({
        step: actions.length + 1,
        clickPosition: { x, y },
        elementHTML: currentElementHTML,
        screenshot: screenshotPath,
        url: currentUrl,
      });

      await overlayClickPosition(screenshotPath, screenshotPath, x, y);
      await selectFirstOption(page);
      await fillInputFields(page);

      console.log(`Clicking at position: (${x}, ${y})`);
      await page.mouse.move(x - 5, y - 5); // Move mouse close to the target
      await sleep(Math.floor(Math.random() * 1000) + 500); // Random delay
      await page.mouse.click(x, y);

      // Check if a new tab was opened
      const newPageTarget = await browser.waitForTarget(target => target.opener() === page.target(), { timeout: 5000 }).catch(() => null);
      if (newPageTarget) {
        console.log('New tab opened, switching to new tab');
        page = await newPageTarget.page();
        await page.bringToFront();
        console.log(`Switched to new page with URL: ${await page.url()}`);
        await page.setDefaultNavigationTimeout(60000);
      }

      try {
        await page.waitForNavigation({ timeout: 5000 });
        console.log('Navigation event detected and finished.');
      } catch (error) {
        console.log('No navigation event detected.');
      }

      ({ screenshotPath, currentUrl } = await takeScreenshot());

      // Limit the clicks to 10
      if (actions.length > 10) {
        break;
      }
    }

    fs.writeFileSync(outputJSONPath, JSON.stringify(actions, null, 2));
    console.log(`Actions saved to: ${outputJSONPath}`);

    await browser.close();
  } catch (error) {
    console.error('Error:', error);
  } finally {
    if (client) {
      client.end();
      console.log('Socket connection closed');
    }
  }
}

async function main() {
  const executablePath = puppeteer.executablePath();
  console.log(`Using Chromium executable at: ${executablePath}`);
  const filePath = path.join(__dirname, 'urls.txt');
  const urls = fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .map((url) => url.trim())
    .filter((url) => url.length > 0)
    .map((url) => (url.startsWith('http://') || url.startsWith('https://') ? url : `http://${url}`));

  await runCrawler("https://www.bankofhope.com")
}

main();
