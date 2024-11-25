from transformers import Qwen2VLForConditionalGeneration, AutoProcessor
from qwen_vl_utils import process_vision_info
from PIL import Image, ImageDraw
import re
import torch

# Load the model on the available device(s)
model = Qwen2VLForConditionalGeneration.from_pretrained(
    "OS-Copilot/OS-Atlas-Base-7B", torch_dtype="auto", device_map="auto"
)
processor = AutoProcessor.from_pretrained("OS-Copilot/OS-Atlas-Base-7B")

# Open the image
img_path = './screenshots/hancock.png'
img = Image.open(img_path)
width, height = img.size
print("The dimensions of the image are:", width, "x", height)

# Prepare the input message
messages = [
    {
        "role": "user",
        "content": [
            {
                "type": "image",
                "image": img_path,
            },
            {
                "type": "text",
                "text": (
                    """
Please analyze the provided image and perform the following task:

Identify the Login Button:

Locate the button on the page that are used to submit login information or navigate to a login page.
Provide a brief description (e.g., "Button labeled 'Login'", "Button with text 'Sign In'", "Icon button with a lock symbol").
Provide its bounding box coordinates.
Output Format:

Element Type: Login Button
Description: [Brief description]
Bounding Box Coordinates: (x1, y1, x2, y2)
Guidelines:

Accuracy: Provide precise bounding box coordinates for the button.
Clarity: Use clear and concise language in your descriptions.
Exclusivity: Do not include any other elements or input fields.
No Additional Commentary: Provide only the requested information without extra explanations.
                    """,
                ),
            },
        ],
    }
]

# Preparation for inference
text = processor.apply_chat_template(
    messages, tokenize=False, add_generation_prompt=True
)
image_inputs, video_inputs = process_vision_info(messages)
inputs = processor(
    text=[text],
    images=image_inputs,
    videos=video_inputs,
    padding=True,
    return_tensors="pt",
)
inputs = inputs.to("cuda" if torch.cuda.is_available() else "cpu")

# Inference: Generation of the output
generated_ids = model.generate(**inputs, max_new_tokens=512)
generated_ids_trimmed = [
    out_ids[len(in_ids):] for in_ids, out_ids in zip(inputs.input_ids, generated_ids)
]
output_text = processor.batch_decode(
    generated_ids_trimmed, skip_special_tokens=False, clean_up_tokenization_spaces=False
)
print("Model Output:", output_text)

# Extract bounding box coordinates using the new pattern
pattern = r'Bounding Box Coordinates:\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)'
matches = re.findall(pattern, output_text[0])
print("Extracted Matches:", matches)

# Convert matches to a list of tuples with integer values
bounding_boxes = [
    ((int(x1), int(y1)), (int(x2), int(y2))) for x1, y1, x2, y2 in matches
]
print("Original bounding boxes:", bounding_boxes)

# Get image dimensions
width, height = img.size

# Define the scale factor
# If the coordinates from the model are in a normalized scale (e.g., 0 to 1000),
# set scale_factor to 1000. Adjust accordingly if different.
scale_factor = 1000

# Scale coordinates based on image dimensions
scaled_bounding_boxes = [
    (
        (int((x1 / scale_factor) * width), int((y1 / scale_factor) * height)),
        (int((x2 / scale_factor) * width), int((y2 / scale_factor) * height))
    )
    for (x1, y1), (x2, y2) in bounding_boxes
]
print("Scaled bounding boxes:", scaled_bounding_boxes)

# Create a drawing context
draw = ImageDraw.Draw(img)

# Draw each bounding box
for box in scaled_bounding_boxes:
    draw.rectangle(box, outline="red", width=3)

# Save the image with the bounding boxes
output_filepath = './output/westpac-ss-bbox.png'
img.save(output_filepath)
print(f"Image saved with bounding boxes at: {output_filepath}")
