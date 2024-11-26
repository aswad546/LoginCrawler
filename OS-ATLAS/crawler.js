const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const net = require('net');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

// Add stealth plugin to puppeteer
puppeteer.use(StealthPlugin());

// Function to generate a valid directory name based on the URL
function generateParentDirectoryName(url) {
  return `${url.replace(/https?:\/\//, '').replace(/[^\w]/g, '_')}`;
}

// Function to generate a valid directory name based on the flow index
function generateFlowDirectoryName(flowIndex) {
  return `flow_${flowIndex}`;
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

// Function to get all select elements and their options
async function getSelectOptions(page) {
  const selectElements = await page.$$('select');
  const allSelectOptions = [];

  for (let select of selectElements) {
    const options = await page.evaluate((select) => {
      return Array.from(select.options).map((option) => option.value);
    }, select);
    allSelectOptions.push({ element: select, options });
  }

  return allSelectOptions;
}

// Flatten the selectOptions array to make exploration easier
function flattenSelectOptions(selectOptions) {
  return selectOptions.reduce((acc, { element, options }) => {
    options.forEach((option) => {
      acc.push({ element, value: option });
    });
    return acc;
  }, []);
}

// Recursive function to explore all flows for different select options
async function exploreFlows(page, url, client, selectOptions, parentDir, flowIndex = 0, screenshotIndex = 1, clickCount = 0) {
  if (clickCount >= 10) {
    return;
  }

  // Flatten the selectOptions array
  const flattenedOptions = flattenSelectOptions(selectOptions);

  if (flowIndex >= flattenedOptions.length) {
    // Base case: No more select elements to explore, perform the remaining actions
    return await continueFlow(page, url, client, parentDir, flowIndex, screenshotIndex, clickCount);
  }

  // Create a new directory for this flow inside the parent directory
  const flowDirName = generateFlowDirectoryName(flowIndex);
  const flowDir = path.join(parentDir, flowDirName);
  if (!fs.existsSync(flowDir)) {
    fs.mkdirSync(flowDir);
  }

  const { element, value } = flattenedOptions[flowIndex];

  // Set the value of the current select element
  await page.evaluate((select, value) => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, element, value);

  console.log(`Selected value: ${value} for flow index ${flowIndex}`);

  // Recursive call to explore the next select element
  await exploreFlows(page, url, client, selectOptions, parentDir, flowIndex + 1, screenshotIndex, clickCount);

  // After setting the value, continue to the next page if navigation occurs
  try {
    await page.waitForNavigation({ timeout: 5000 });
    console.log('Navigation event detected and finished.');
    // After navigation, get new select options and continue exploration
    const newSelectOptions = await getSelectOptions(page);
    await exploreFlows(page, url, client, newSelectOptions, parentDir, 0, screenshotIndex, clickCount);
  } catch (error) {
    console.log('No navigation event detected.(explore flows)');
  }
}

async function fillInputFields(page) {
  const inputElements = await page.$$('input');

  for (let input of inputElements) {
    try {
      await input.evaluate((element) => element.scrollIntoView());
      await sleep(Math.floor(Math.random() * 500) + 500); // Random delay after scrolling

      const isVisible = await input.evaluate((element) => {
        const style = window.getComputedStyle(element);
        return style && style.visibility !== 'hidden' && style.display !== 'none';
      });

      const isReadOnly = await input.evaluate((element) => element.hasAttribute('readonly'));
      const isDisabled = await input.evaluate((element) => element.hasAttribute('disabled'));

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

// Function to continue with actions after exploring select elements
async function continueFlow(page, url, client, parentDir, flowIndex, screenshotIndex, clickCount) {
  const actions = []; // To store the action history
  const flowDirName = generateFlowDirectoryName(flowIndex);
  const flowDir = path.join(parentDir, flowDirName);

  await fillInputFields(page);

  // Function to take screenshots
  const takeScreenshot = async () => {
    const screenshotPath = path.join(flowDir, generateFileName(screenshotIndex));
    if (!fs.existsSync(flowDir)) {
      fs.mkdirSync(flowDir, { recursive: true });
    }
    await page.screenshot({ path: screenshotPath });
    console.log(`Screenshot saved to: ${screenshotPath}`);
    const currentUrl = await page.url();
    screenshotIndex++;
    return { screenshotPath, currentUrl };
  };

  let { screenshotPath, currentUrl } = await takeScreenshot();
  let previousElementHTML = null;

  // Main loop to interact with elements based on server response
  while (clickCount < 10) {
    client.write(`${screenshotPath}\n`);

    // Wait for response from the server
    let clickPosition = await new Promise((resolve) => {
      client.once('data', (data) => {
        console.log(`Received from server: ${data}`);
        resolve(data.toString().trim());
      });
    });

    const match = clickPosition.match(/Click Point:\s*(\d+),\s*(\d+)/);
    if (clickPosition === 'No login button detected') {
      console.log('No login button detected');
      break;
    } else if (!match) {
      console.error(`Invalid data received from socket: ${clickPosition}`);
      throw new Error(`Invalid click position: ${clickPosition}`);
    }

    const [x, y] = match.slice(1).map(Number);

    const currentElementHTML = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      return element ? element.outerHTML : null;
    }, { x, y });

    if (currentElementHTML === null || currentElementHTML === previousElementHTML) {
      console.log('No element found or repeated element at the click position.');
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
    console.log(`Clicking at position: (${x}, ${y})`);
    await page.mouse.move(x - 5, y - 5);
    await sleep(Math.floor(Math.random() * 1000) + 500);
    await page.mouse.click(x, y);

    clickCount++;

    // Check if a new tab was opened
    const newPageTarget = await page.browser().waitForTarget(target => target.opener() === page.target(), { timeout: 5000 }).catch(() => null);
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
  }

  // Write actions to JSON file for this specific flow
  const outputJSONPath = path.join(flowDir, `click_actions_flow_${flowIndex}.json`);
  fs.writeFileSync(outputJSONPath, JSON.stringify(actions, null, 2));
  console.log(`Actions saved to: ${outputJSONPath}`);
}

// Function to take screenshot and connect to socket
async function runCrawler(url) {
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
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--start-fullscreen',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    let page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/102.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => {
      delete navigator.__proto__.webdriver;
    });

    await page.setDefaultNavigationTimeout(60000);
    await page.goto(url, { waitUntil: 'load' });
    await sleep(Math.floor(Math.random() * 2000) + 1000);

    // Create a parent directory for the URL
    const parentDir = path.join(__dirname, 'screenshot_flows', generateParentDirectoryName(url));
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    const selectOptions = await getSelectOptions(page);
    await exploreFlows(page, url, client, selectOptions, parentDir, 0, 1, 0);

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
  await runCrawler("https://www.bankofhope.com");
}

main();
