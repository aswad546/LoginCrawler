from PIL import Image, ImageDraw
import re

# Filepath to the image
filepath = './screenshots/westpac-ss.png'

# Open the image
img = Image.open(filepath)

# Get image dimensions
width, height = img.size
print("The dimensions of the image are:", width, "x", height)

# Input string containing coordinates
input_string = '<|object_ref_start|>login button<|object_ref_end|><|box_start|>(809,54),(838,81)<|box_end|><|im_end|>'

# Regular expression pattern to extract coordinates
pattern = r'\((\d+),(\d+)\)'

# Find all matches in the input string
matches = re.findall(pattern, input_string)

# Convert matches to a list of tuples with integer values
coordinates = [(int(x), int(y)) for x, y in matches]
print("Original coordinates:", coordinates)

# Scale coordinates based on image dimensions
scaled_coordinates = [
    (((x / 1000) * width), ((y / 1000) * height)) for x, y in coordinates
]
print("Scaled coordinates:", scaled_coordinates)

# Ensure there are exactly two coordinates to form a bounding box
if len(scaled_coordinates) == 2:
    # Create a drawing context
    draw = ImageDraw.Draw(img)

    # Draw the rectangle (bounding box)
    draw.rectangle(scaled_coordinates, outline="red", width=3)

    # Save the image with the bounding box
    output_filepath = './screenshots/westpac-ss-bbox.png'
    img.save(output_filepath)
    print(f"Image saved with bounding box at: {output_filepath}")
else:
    print("Error: Expected exactly two coordinates to form a bounding box.")
