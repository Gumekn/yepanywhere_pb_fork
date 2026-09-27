import { createContext, useContext } from "react";

export interface FileTabOpener {
  openFileTab: (relativePath: string) => void;
}

export const FileTabOpenerContext = createContext<FileTabOpener | null>(null);

export function useFileTabOpener(): FileTabOpener | null {
  return useContext(FileTabOpenerContext);
}
