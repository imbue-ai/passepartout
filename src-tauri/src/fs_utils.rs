use std::fs;
use std::path::Path;

/// Copy contents of a directory into another directory
pub fn copy_dir_contents(src: &Path, dst: &Path) -> Result<(), String> {
    let entries = fs::read_dir(src)
        .map_err(|e| format!("Failed to read directory {:?}: {}", src, e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();
        let dest_path = dst.join(entry.file_name());

        if path.is_dir() {
            fs::create_dir_all(&dest_path)
                .map_err(|e| format!("Failed to create directory {:?}: {}", dest_path, e))?;
            copy_dir_contents(&path, &dest_path)?;
        } else {
            fs::copy(&path, &dest_path)
                .map_err(|e| format!("Failed to copy {:?} to {:?}: {}", path, dest_path, e))?;
        }
    }

    Ok(())
}
