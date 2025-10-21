export const makeMutex = () => {
  let task: Promise<unknown> = Promise.resolve();
  return {
    mutex<T>(code: () => Promise<T> | T): Promise<T> {
      const newTask = (async () => {
        // wait for the previous task to complete
        // if there is an error, we swallow so as to not block the queue
        try {
          await task;
        } catch (error) {
          // Intentionally swallow errors to prevent blocking the mutex queue
        }

        // execute the current task
        return code();
      })();
      // we replace the existing task, appending the new piece of execution to it
      // so the next task will have to wait for this one to finish
      task = newTask;
      return newTask;
    }
  };
};

export type Mutex = ReturnType<typeof makeMutex>;

export const makeKeyedMutex = () => {
  const map: { [id: string]: Mutex } = {};

  return {
    mutex<T>(key: string, task: () => Promise<T> | T): Promise<T> {
      if (!map[key]) {
        map[key] = makeMutex();
      }

      return map[key].mutex(task);
    }
  };
};
