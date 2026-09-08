from flask import Flask, send_from_directory, jsonify, request
from flask_cors import CORS
import os
import json
import threading
import webbrowser

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=BASE_DIR)
CORS(app)  # Enable CORS for all routes

# Serve the main HTML file
@app.route('/')
def index():
    return send_from_directory(BASE_DIR, 'index.html')

# Serve static files (JS, CSS, images, etc.)
@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory(BASE_DIR, path)

# API endpoint to list all JSON files in data/tru directory
@app.route('/api/tru/list')
def list_tru_files():
    try:
        tru_dir = os.path.join(BASE_DIR, 'data', 'tru')
        files = []
        if os.path.exists(tru_dir):
            for filename in os.listdir(tru_dir):
                if filename.endswith('.json'):
                    files.append({
                        'key': filename.replace('.json', ''),
                        'url': f'/data/tru/{filename}'
                    })
        return jsonify({'files': files})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# API endpoint to list cot trung the regions
@app.route('/api/cot-trung-tuyen/regions')
def list_cot_regions():
    try:
        manifest_path = os.path.join(BASE_DIR, 'cot_trung_tuyen', 'json_cot', 'manifest.json')
        if os.path.exists(manifest_path):
            with open(manifest_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                return jsonify(data)
        return jsonify({'error': 'Manifest not found'}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# API endpoint to get route data
@app.route('/api/routes')
def get_routes():
    try:
        routes_path = os.path.join(BASE_DIR, 'data', 'getroute.json')
        if os.path.exists(routes_path):
            with open(routes_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                return jsonify(data)
        return jsonify({'error': 'Routes file not found'}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# API endpoint to get location data
@app.route('/api/locations')
def get_locations():
    try:
        locations_path = os.path.join(BASE_DIR, 'data', 'getlocation.json')
        if os.path.exists(locations_path):
            with open(locations_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                return jsonify(data)
        return jsonify({'error': 'Locations file not found'}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# API endpoint to save console logs
@app.route('/api/save-log', methods=['POST'])
def save_log():
    try:
        data = request.get_json()
        log_content = data.get('content', '')
        timestamp = data.get('timestamp', '')
        
        # Save to log.txt (overwrite old content)
        log_path = os.path.join(BASE_DIR, 'log.txt')
        with open(log_path, 'w', encoding='utf-8') as f:
            f.write(f"# Console Log - Last Updated: {timestamp}\n")
            f.write("=" * 60 + "\n\n")
            f.write(log_content)
        
        return jsonify({'status': 'ok', 'message': 'Log saved successfully', 'log_path': log_path})
    except Exception as e:
        return jsonify({'error': str(e)}), 500



if __name__ == '__main__':
    # Run on port 5000 by default
    # Access at: http://localhost:5000
    threading.Timer(1.0, lambda: webbrowser.open('http://127.0.0.1:5000/')).start()
    app.run(debug=False, host='0.0.0.0', port=5000)
