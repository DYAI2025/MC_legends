import type { SubmissionRepository } from "@/application/submissions/submission-repository";
import type { SubmissionId, TextSubmission } from "@/domain/submissions/submission";

const DEFAULT_DATABASE_NAME = "avaloria-submissions";
const DATABASE_VERSION = 1;
const STORE_NAME = "submissions";

export class IndexedDbSubmissionRepository implements SubmissionRepository {
  constructor(private readonly databaseName = DEFAULT_DATABASE_NAME) {}

  async save(submission: TextSubmission): Promise<void> {
    const database = await this.openDatabase();

    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).put(submission);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB save failed"));
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB save aborted"));
      });
    } finally {
      database.close();
    }
  }

  async findById(id: SubmissionId): Promise<TextSubmission | null> {
    const database = await this.openDatabase();

    try {
      return await new Promise<TextSubmission | null>((resolve, reject) => {
        const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(id);
        request.onsuccess = () => resolve((request.result as TextSubmission | undefined) ?? null);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
      });
    } finally {
      database.close();
    }
  }

  async list(): Promise<readonly TextSubmission[]> {
    const database = await this.openDatabase();

    try {
      return await new Promise<readonly TextSubmission[]>((resolve, reject) => {
        const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
        request.onsuccess = () => {
          const submissions = (request.result as TextSubmission[]).toSorted((left, right) =>
            left.createdAt.localeCompare(right.createdAt),
          );
          resolve(submissions);
        };
        request.onerror = () => reject(request.error ?? new Error("IndexedDB list failed"));
      });
    } finally {
      database.close();
    }
  }

  private openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, DATABASE_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
      request.onblocked = () => reject(new Error("IndexedDB open blocked"));
    });
  }
}
