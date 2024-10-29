import torch
from PIL import Image
from transformers import MllamaForConditionalGeneration, AutoProcessor
import asyncio
import websockets
import base64
import time
import json
import io
from transformers import AutoTokenizer
from bs4 import BeautifulSoup

def prune_html(html_content):
    # Parse the HTML content using BeautifulSoup
    soup = BeautifulSoup(html_content, 'html.parser')

    # Remove the <head> tag and its contents
    if soup.head:
        soup.head.decompose()

    # Remove all <script> and <style> tags
    for script_or_style in soup(["script", "style"]):
        script_or_style.decompose()

    # Join the remaining HTML back into a string
    return str(soup)


# Load the model and processor once at startup
model_id = "meta-llama/Llama-3.2-11B-Vision-Instruct"
model = MllamaForConditionalGeneration.from_pretrained(
    model_id,
    torch_dtype=torch.bfloat16,
    device_map="auto",
)
processor = AutoProcessor.from_pretrained(model_id)

# Load the tokenizer
tokenizer = AutoTokenizer.from_pretrained(model_id)

def count_tokens(input_text):
    tokens = tokenizer.encode(input_text)
    return len(tokens)

async def handle_client(websocket, path):
    try:
        async for message in websocket:
            print('Message received')
            # Parse the received message
            data = json.loads(message)
            image_path = data.get("image_path")
            html_path = data.get("html_path")

            if not image_path or not html_path:
                await websocket.send(json.dumps({"error": "Missing image or HTML file path"}))
                continue

            # Load the image from the given path
            try:
                image = Image.open(image_path).convert('RGB')
            except Exception as e:
                await websocket.send(json.dumps({"error": f"Failed to load image: {str(e)}"}))
                continue

            # Read the HTML content from the given path
            try:
                with open(html_path, 'r', encoding='utf-8') as html_file:
                    html_content = html_file.read()
                    html_content = prune_html(html_content)
                    # print(html_content)
            except Exception as e:
                await websocket.send(json.dumps({"error": f"Failed to load HTML file: {str(e)}"}))
                continue

            # Prepare the messages for the model
            messages = [
                {"role": "user", "content": [
                    {"type": "image"},
                    {"type": "text", "text": """
You are a web assistant that helps users find login pages. I have provided you with an image of the webpage along with its HTML code.
Please answer the following questions based on your analysis of both the image and HTML:
1. **Is this a login page? Only consider this a login page if it has visible input fields for userid, password, email, username etc** (Answer: Yes/No)
- If Yes: Explain why, referencing any visible username or password fields.
2. **If No**:
- Find where a user can click to reach the login page. Ensure that the clickable element is visible in the provided image.
- Provide the HTML code for this clickable element in this format: `HTML: (HTML content)`.

Make sure to:
- Verify the presence of username or password fields visually and through the HTML.
- Cross-reference the HTML elements with the visual content to ensure they match.

**Here is the HTML of the page**:
                    """ + html_content}
                ]}
            ]

            # Apply chat template and prepare inputs for the model
            input_text = processor.apply_chat_template(messages, add_generation_prompt=True)

            # Count the number of tokens in the input
            num_tokens = count_tokens(input_text)
            print(f"Number of tokens in the input: {num_tokens}")

            inputs = processor(
                image,
                input_text,
                add_special_tokens=False,
                return_tensors="pt"
            ).to(model.device)

            # Generate output and measure the time taken
            start_time = time.time()
            output = model.generate(**inputs, max_new_tokens=500)
            end_time = time.time()

            query_time = end_time - start_time

            # Decode the model's response
            response = processor.decode(output[0], skip_special_tokens=True)
            response_content = response.split('assistant')[-1].strip()

            # Send the response back to the client
            response_message = {
                "response": response_content,
                "query_time": query_time
            }
            await websocket.send(json.dumps(response_message))

    except websockets.ConnectionClosed:
        print(f"Connection closed from {websocket.remote_address}")

async def main():
    async with websockets.serve(handle_client, "localhost", 8765):
        print("WebSocket server started on ws://localhost:8765")
        await asyncio.Future()  # Run forever

if __name__ == "__main__":
    asyncio.run(main())
