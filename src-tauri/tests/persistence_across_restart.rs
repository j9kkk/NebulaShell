// 关键回归:模拟"保存 → 重启应用 → 读回"的真实用户路径。
// 背景:keyring 方案下密码在同一进程可读,重启即丢失(条目在临时 keychain)
// → 用户表现为"密码输入后无效"。本测试用两个独立 Store 实例模拟进程重启。
use nebulashell_lib::config::Store;
use serde_json::json;

#[test]
fn password_survives_simulated_restart() {
    let dir = std::env::temp_dir().join(format!("nb-restart-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);

    // 进程 A:保存主机与密码
    {
        let store = Store::load(dir.clone());
        let saved = store
            .save_host(&json!({
                "name": "prod-web", "host": "10.20.30.40", "port": 22,
                "username": "root", "authType": "password", "password": "MyP@ssw0rd-秘密"
            }))
            .expect("保存主机");
        assert_eq!(saved["hasPassword"], json!(true), "保存后应标记有密码");

        // 同一进程内读取(旧 keyring 方案在这一步是"通过"的,正是误导点)
        let full = store.host_full(saved["id"].as_str().unwrap()).unwrap();
        assert_eq!(full["password"], json!("MyP@ssw0rd-秘密"), "同进程读回");
    }

    // 进程 B:新实例(模拟应用重启)——旧 keyring 方案在此丢失密码
    {
        let store = Store::load(dir.clone());
        let list = store.list_hosts();
        assert_eq!(list.len(), 1, "主机应持久化");
        assert_eq!(list[0]["hasPassword"], json!(true), "重启后仍应标记有密码(界面不显示待补全)");

        let full = store.host_full(list[0]["id"].as_str().unwrap()).unwrap();
        assert_eq!(
            full["password"], json!("MyP@ssw0rd-秘密"),
            "重启后密码必须可读回 —— 否则连接会因'未配置密码'失败"
        );
    }

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn key_and_passphrase_survive_restart() {
    let dir = std::env::temp_dir().join(format!("nb-restart-key-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nKEYDATA\n-----END OPENSSH PRIVATE KEY-----";
    let id;
    {
        let store = Store::load(dir.clone());
        let s = store
            .save_host(&json!({ "name": "k", "host": "10.1.1.1", "authType": "key", "privateKey": pem, "passphrase": "phrase-秘密" }))
            .unwrap();
        id = s["id"].as_str().unwrap().to_string();
    }
    {
        let store = Store::load(dir.clone());
        let full = store.host_full(&id).unwrap();
        assert_eq!(full["privateKey"], json!(pem), "重启后私钥可读回(含换行)");
        assert_eq!(full["passphrase"], json!("phrase-秘密"), "重启后口令可读回");
    }
    let _ = std::fs::remove_dir_all(&dir);
}
