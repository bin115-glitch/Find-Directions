"""
Script to extract JavaScript from load_data_only.html into separate modular files
"""
import re

# Read the HTML file
with open('load_data_only.html', 'r', encoding='utf-8') as f:
    content = f.read()

# Extract the JavaScript section (between <script> and </script>)
script_match = re.search(r'<script>\s*(.*?)\s*</script>', content, re.DOTALL)
if not script_match:
    print("❌ Could not find script section")
    exit(1)

js_code = script_match.group(1)

print(f"✅ Extracted {len(js_code)} characters of JavaScript")
print(f"📝 Total lines: {len(js_code.splitlines())}")

# Save to a temporary file for manual splitting
with open('js/extracted_full.js', 'w', encoding='utf-8') as f:
    f.write(js_code)

print("✅ Saved to js/extracted_full.js")
print("\nℹ️  You can now manually organize this into modular files")
