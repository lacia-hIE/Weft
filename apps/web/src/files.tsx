import React, {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Button, Input } from "./runtime/primitives.ts";
import { api, getSelection, subscribeSelection } from "./api.ts";
import type { Run } from "./ui-types.ts";
import type {
  FileInfo,
  FileRead,
} from "../../../packages/workspace/src/protocol.ts";
import { pluginsCss } from "./upstream-ui.ts";
export function Files({ run }: { run: Run }): ReactNode {
  const selection = useSyncExternalStore(subscribeSelection, getSelection);
  const [path, setPath] = useState("/workspace");
  const [entries, setEntries] = useState<FileInfo[]>([]);
  const [file, setFile] = useState<FileRead>();
  const [content, setContent] = useState("");
  const [newPath, setNewPath] = useState("/workspace/notes.md");
  const base = `workspaces/${selection.workspaceId}/files`;
  async function open(path: string): Promise<void> {
    const { value } = await api<{ value: FileInfo[] | FileRead }>(
      `${base}?path=${encodeURIComponent(path)}`,
    );
    setPath(path);
    if (Array.isArray(value)) {
      setEntries(value);
      setFile(undefined);
    } else {
      setFile(value);
      setContent(value.content);
    }
  }
  useEffect(() => {
    void run(() => open("/workspace"));
  }, [selection.workspaceId]);
  return (
    <div className={`page ${pluginsCss.page}`}>
      <div className={`page-title ${pluginsCss.pageHead}`}>
        <div>
          <h1>{selection.workspaceId}</h1>
          <p>会话共享文件。Skills 放入 .agents/skills/名称/SKILL.md。</p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            void run(() => open("/workspace"));
          }}
        >
          返回根目录
        </Button>
      </div>
      <div className="file-breadcrumb">{path}</div>
      {!file ? (
        <>
          <div className="file-list">
            {entries.map((entry) => (
              <button
                key={entry.path}
                onClick={() => {
                  void run(() => open(entry.path));
                }}
              >
                <span>{entry.type === "directory" ? "▱" : "▤"}</span>
                {entry.path.split("/").at(-1)}
                <small>
                  {entry.type === "directory" ? "目录" : `${entry.size} B`}
                </small>
              </button>
            ))}
            {!entries.length && <p className="muted">这个目录还是空的。</p>}
          </div>
          <div className="settings-card">
            <h3>新建文件</h3>
            <label className="field">
              完整路径
              <Input
                aria-label="新文件路径"
                value={newPath}
                onChange={(event) => {
                  setNewPath(event.target.value);
                }}
              />
            </label>
            <Button
              variant="outline"
              onClick={() => {
                void run(async () => {
                  await api(base, {
                    method: "PUT",
                    body: JSON.stringify({
                      path: newPath,
                      content: "",
                      expectedVersion: null,
                    }),
                  });
                  await open(newPath);
                });
              }}
            >
              创建文件
            </Button>
          </div>
        </>
      ) : (
        <div className="settings-card editor">
          <div className="setting-row">
            <h3>{file.path.split("/").at(-1)}</h3>
            <span className="muted">版本 {file.version}</span>
          </div>
          <textarea
            className="code-editor"
            aria-label="文件内容"
            value={content}
            spellCheck={false}
            onChange={(event) => {
              setContent(event.target.value);
            }}
          />
          <Button
            variant="primary"
            onClick={() => {
              void run(async () => {
                await api(base, {
                  method: "PUT",
                  body: JSON.stringify({
                    path: file.path,
                    content,
                    expectedVersion: file.version,
                  }),
                });
                await open(file.path);
              });
            }}
          >
            保存文件
          </Button>
          <Button
            onClick={() => {
              void run(() =>
                open(file.path.slice(0, file.path.lastIndexOf("/"))),
              );
            }}
          >
            返回上级
          </Button>
        </div>
      )}
    </div>
  );
}
