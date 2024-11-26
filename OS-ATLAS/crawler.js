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
    const options = await select.evaluate((select) => {
      return Array.from(select.options).map((option) => option.value);
    });
    allSelectOptions.push(options);
  }

  return allSelectOptions;
}

// Function to generate all combinations of select options
function generateOptionCombinations(optionsArray) {
  const combinations = [];

  const helper = (currentCombination, depth) => {
    if (depth === optionsArray.length) {
      combinations.push([...currentCombination]);
      return;
    }
    for (let option of optionsArray[depth]) {
      currentCombination.push(option);
      helper(currentCombination, depth + 1);
      currentCombination.pop();
    }
  };

  helper([], 0);
  return combinations;
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

// Function to detect navigation or new tab
async function detectNavigationOrNewTab(page) {
  const timeout = 5000;
  const browser = page.browser();

  return Promise.race([
    page.waitForNavigation({ timeout }).then(() => {
      console.log('Navigation detected.');
      return page;
    }).catch(() => null),
    new Promise(resolve => {
      const listener = async target => {
        if (target.opener() === page.target()) {
          const newPage = await target.page();
          await newPage.bringToFront();
          console.log('New tab detected.');
          browser.off('targetcreated', listener);
          resolve(newPage);
        }
      };
      browser.on('targetcreated', listener);
      setTimeout(() => {
        browser.off('targetcreated', listener);
        resolve(null);
      }, timeout);
    })
  ]);
}

// Function to perform the flow for a given combination of select options
async function performFlow(browser, url, parentDir, client, selectCombination, flowIndex, clickLimit) {
  let page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
  await page.setViewport({ width: 1280, height: 800 });
  await page.evaluateOnNewDocument(() => {
    delete navigator.__proto__.webdriver;
  });
  await page.setDefaultNavigationTimeout(60000);

  try {
    await page.goto(url, { waitUntil: 'load' });
    await sleep(Math.floor(Math.random() * 2000) + 1000);

    // Apply the select options
    const selectElements = await page.$$('select');
    for (let i = 0; i < selectCombination.length; i++) {
      const selectElement = selectElements[i];
      const value = selectCombination[i];

      await selectElement.evaluate((select, value) => {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }, value);

      console.log(`Set select index ${i} to value ${value}`);

      // Wait for any potential navigation
      const newPage = await detectNavigationOrNewTab(page);
      if (newPage && newPage !== page) {
        console.log('Navigation or new tab detected after selecting option.');
        page = newPage;
        await page.bringToFront();
      }
    }

    // Proceed with the flow
    await continueFlow(page, url, client, parentDir, flowIndex, 1, 0, clickLimit);

  } catch (error) {
    console.error('Error during flow:', error);
  } finally {
    await page.close();
  }
}

// Function to continue with actions after selecting options
async function continueFlow(page, url, client, parentDir, flowIndex, screenshotIndex, clickCount, clickLimit) {
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
  while (clickCount < clickLimit) {
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

    // Check for navigation or new tab
    const newPage = await detectNavigationOrNewTab(page);
    if (newPage && newPage !== page) {
      console.log('New tab or navigation detected after click, switching to new page');
      page = newPage;
      await page.bringToFront();
      await page.setDefaultNavigationTimeout(60000);
    }

    ({ screenshotPath, currentUrl } = await takeScreenshot());
  }

  // Write actions to JSON file for this specific flow
  const outputJSONPath = path.join(flowDir, `click_actions_flow_${flowIndex}.json`);
  fs.writeFileSync(outputJSONPath, JSON.stringify(actions, null, 2));
  console.log(`Actions saved to: ${outputJSONPath}`);
}

// Function to run the crawler
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

    // Create a parent directory for the URL
    const parentDir = path.join(__dirname, 'screenshot_flows', generateParentDirectoryName(url));
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // Open a page to get the select options
    let page = await browser.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await sleep(Math.floor(Math.random() * 2000) + 1000);

    const selectOptions = await getSelectOptions(page);
    await page.close();

    // Generate all combinations of select options
    const optionsArray = selectOptions;
    const combinations = generateOptionCombinations(optionsArray);
    console.log(`Generated ${combinations.length} combinations of select options.`);

    // Iterate over each combination and perform the flow
    for (let i = 0; i < combinations.length; i++) {
      const selectCombination = combinations[i];
      console.log(`Starting flow ${i} with select options: ${selectCombination}`);
      await performFlow(browser, url, parentDir, client, selectCombination, i, 10);
    }

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

const fs = require('fs');
const path = require('path');

// Function to read URLs from the file and add "http://" if not present
function getUrlsFromFile(filePath) {
  try {
    const urls = fs.readFileSync(filePath, 'utf-8')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(url => (url.startsWith('http://') || url.startsWith('https://') ? url : `http://${url}`));
    return urls;
  } catch (error) {
    console.error(`Error reading file: ${error.message}`);
    return [];
  }
}

// Main function to process URLs
async function main() {
  const filePath = path.join(__dirname, 'urls.txt'); // Path to the file
  const urls = getUrlsFromFile(filePath);

  if (urls.length === 0) {
    console.log('No URLs found in the file.');
    return;
  }

  console.log(`Found ${urls.length} URLs. Starting crawler...`);

  for (const url of urls) {
    console.log(`Processing URL: ${url}`);
    try {
      await runCrawler(url); // Call the crawler for each URL
    } catch (error) {
      console.error(`Error processing URL ${url}: ${error.message}`);
    }
  }

  console.log('Finished processing all URLs.');
}


main();
