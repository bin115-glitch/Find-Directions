import json
import os
import pandas as pd
from pathlib import Path

def main():
    # Đường dẫn các thư mục
    base_dir = Path(__file__).parent
    data_dir = base_dir / "data"
    ring_dir = data_dir / "ring"
    getroute_file = data_dir / "getroute.json"
    output_dir = base_dir / "output_excel"
    
    # Tạo thư mục output nếu chưa có
    output_dir.mkdir(exist_ok=True)
    
    # Đọc file getroute.json để có mapping id -> name
    print("Đọc file getroute.json...")
    with open(getroute_file, 'r', encoding='utf-8') as f:
        getroute_data = json.load(f)
    
    # Tạo dictionary mapping id -> name
    id_to_name = {}
    for item in getroute_data.get('table', []):
        route_id = item.get('id')
        route_name = item.get('name')
        if route_id and route_name:
            id_to_name[route_id] = route_name
    
    print(f"Đã tìm thấy {len(id_to_name)} routes trong getroute.json")
    
    # Quét các file trong thư mục ring
    print(f"\nQuét thư mục ring: {ring_dir}")
    ring_files = list(ring_dir.glob("Axis_id=*.json"))
    print(f"Tìm thấy {len(ring_files)} file")
    
    # Xử lý từng file
    success_count = 0
    error_count = 0
    
    for ring_file in ring_files:
        try:
            # Lấy ID từ tên file (ví dụ: Axis_id=62.json -> 62)
            file_id = int(ring_file.stem.split('=')[1])
            
            # Tìm name tương ứng
            if file_id not in id_to_name:
                print(f"⚠️  Không tìm thấy name cho ID {file_id} trong getroute.json")
                error_count += 1
                continue
            
            route_name = id_to_name[file_id]
            
            # Đọc dữ liệu từ file ring
            print(f"\nXử lý: {ring_file.name} -> {route_name}.xlsx")
            with open(ring_file, 'r', encoding='utf-8') as f:
                ring_data = json.load(f)
            
            # Lấy danh sách các items từ table
            items = ring_data.get('table', [])
            
            if not items:
                print(f"⚠️  File {ring_file.name} không có dữ liệu trong 'table'")
                error_count += 1
                continue
            
            # Chuyển đổi sang DataFrame
            df = pd.DataFrame(items)
            
            # Tên file Excel là route name (làm sạch tên file)
            # Loại bỏ các ký tự không hợp lệ cho tên file
            safe_name = route_name.replace('/', '_').replace('\\', '_').replace(':', '_')
            excel_file = output_dir / f"{safe_name}.xlsx"
            
            # Xuất ra Excel
            df.to_excel(excel_file, index=False, sheet_name='Data')
            
            print(f"✓ Đã tạo: {excel_file.name} ({len(items)} bản ghi)")
            success_count += 1
            
        except Exception as e:
            print(f"✗ Lỗi khi xử lý {ring_file.name}: {str(e)}")
            error_count += 1
    
    # Tổng kết
    print("\n" + "="*60)
    print(f"Hoàn thành!")
    print(f"  • Thành công: {success_count} file")
    print(f"  • Lỗi: {error_count} file")
    print(f"  • Thư mục output: {output_dir}")
    print("="*60)

if __name__ == "__main__":
    main()
