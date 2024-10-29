const puppeteer = require('puppeteer-extra');
const WebSocket = require('ws');
const fs = require('fs');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');


puppeteer.use(StealthPlugin());


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


// Connect to the WebSocket server
const ws = new WebSocket('ws://localhost:8765');

// Helper function to wait for the WebSocket to be ready
function waitForWebSocketOpen(ws) {
    return new Promise((resolve, reject) => {
        if (ws.readyState === WebSocket.OPEN) {
            resolve();
        } else {
            ws.on('open', resolve);
            ws.on('error', reject);
        }
    });
}

// Function to send data to the model server
function sendToModelServer(imagePath, htmlPath) {
    return new Promise((resolve, reject) => {
        // Create the message to send with file paths
        const message = {
            image_path: imagePath,
            html_path: htmlPath
        };

        // Send the message to the WebSocket server
        ws.send(JSON.stringify(message));

        // Wait for the response
        ws.once('message', (data) => {
            const response = JSON.parse(data);
            if (response.error) {
                reject(response.error);
            } else {
                // console.log('Received from server:', response);
                resolve(response);
            }
        });

        ws.on('error', (err) => {
            console.error('WebSocket error:', err);
            reject(err);
        });
    });
}

const parseLLMResponse = (response) => {
    // Initialize variables to store the extracted information
    let isLoginPage = null;
    let htmlContent = null;

    // Split the response into lines
    const lines = response.split('\n');

    // Iterate over the lines to find relevant information
    for (const line of lines) {
        // Look for the login page status
        if (line.startsWith('Is this a login page?')) {
            isLoginPage = line.includes('**No**') ? 'No' : 'Yes';
        }

        // Detect when HTML content starts
        const htmlMatch = line.match(/^HTML:\s*(<.*)$/); // Regex to detect HTML content
        if (htmlMatch) {
            htmlContent = htmlMatch[1];
            break; // Assuming there's only one HTML block to parse
        }
    }

    // Return the parsed information as an object
    return {
        isLoginPage,
        htmlContent,
    };
};


// Example Puppeteer usage
(async () => {
    try {
        // Launch Puppeteer and navigate to the desired page
        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--start-fullscreen']
        });

        const page = await browser.newPage();
        const url = 'https://www.cadencebank.com';
        let file_name = url.split('/').filter(Boolean).pop();
        file_name = file_name.split('.').slice(0, -1).join('.'); 

       

        console.log(file_name);
        await page.goto(url, { waitUntil: 'load', timeout: 300000 });
        await sleep(5000)
        
        console.log('Page loaded');

        // Take a screenshot of the page
        const imagePath = `/u1/a8tariq/Llama vision/login_crawler/screenshots/${file_name}.png`;
        await page.screenshot({ path: imagePath });
        console.log('Screenshot taken and saved');

        // Save HTML content of the page
        const htmlPath = `/u1/a8tariq/Llama vision/login_crawler/page_source/${file_name}.html`;
        const htmlContent = await page.content();
        fs.writeFileSync(htmlPath, htmlContent);
        console.log('HTML file recorded and saved');

        console.log('Waiting for WebSocket connection to open');

        // Wait for the WebSocket connection to open
        await waitForWebSocketOpen(ws);
        console.log('Connected to Python WebSocket server');

        // Send paths to the model server
        try {
            console.log('Sending message to LLM');
            const response = await sendToModelServer(imagePath, htmlPath);
            // const parsedResponse = parseLLMResponse(response)
            console.log('Model Response:', response, typeof response);
        } catch (error) {
            console.error('Error communicating with model server:', error);
        }

        // Close Puppeteer after request
        await browser.close();
        ws.close(); // Close WebSocket connection when done

    } catch (error) {
        console.error('Error during Puppeteer usage:', error);
    }
})();