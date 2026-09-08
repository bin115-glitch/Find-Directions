import json
import os

def generate_tru_index(tru_dir="data/tru", output_file="data/tru_index.json"):
    """
    Tạo file index chứa danh sách tất cả file JSON trong thư mục data/tru
    
    Args:
        tru_dir: Đường dẫn đến thư mục chứa file JSON
        output_file: Đường dẫn file output
        
    Returns:
        Số lượng file được index
    """
    if not os.path.exists(tru_dir):
        print(f"❌ Thư mục không tồn tại: {tru_dir}")
        return 0
    
    # Lấy danh sách tất cả file JSON
    json_files = sorted([f for f in os.listdir(tru_dir) if f.endswith('.json')])
    
    if not json_files:
        print(f"⚠️  Không tìm thấy file JSON nào trong {tru_dir}")
        return 0
    
    # Tạo danh sách index
    files_list = []
    for filename in json_files:
        # Loại bỏ extension .json để làm key
        key = filename.replace('.json', '')
        files_list.append({
            "key": key,
            "url": f"./data/tru/{filename}"
        })
    
    # Tạo object index
    index_data = {
        "files": files_list,
        "count": len(files_list),
        "generated_at": None  # Có thể thêm timestamp nếu cần
    }
    
    # Ghi ra file
    os.makedirs(os.path.dirname(output_file) if os.path.dirname(output_file) else ".", exist_ok=True)
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(index_data, f, ensure_ascii=False, indent=2)
    
    print(f"✅ Đã tạo index cho {len(files_list)} file JSON")
    print(f"📁 File index: {os.path.abspath(output_file)}")
    
    return len(files_list)

if __name__ == "__main__":
    print("🔍 Tạo index cho file JSON trong data/tru")
    print("=" * 60)
    count = generate_tru_index()
    print("=" * 60)
    print(f"✨ Hoàn thành! Đã index {count} file.")
