export interface LocalWriteBarrier {
  runMutation<T>(action: () => Promise<T>): Promise<T>;
  runReconcile<T>(action: () => Promise<T>): Promise<T>;
}

export function createLocalWriteBarrier(): LocalWriteBarrier {
  let activeMutations = 0;
  let reconcileInProgress = false;
  const mutationWaiters: Array<() => void> = [];
  const reconcileWaiters: Array<() => void> = [];

  const drainNext = () => {
    if (reconcileInProgress) {
      return;
    }

    if (reconcileWaiters.length > 0) {
      if (activeMutations === 0) {
        reconcileInProgress = true;
        const nextReconcile = reconcileWaiters.shift()!;
        nextReconcile();
      }
      return;
    }

    while (mutationWaiters.length > 0 && reconcileWaiters.length === 0) {
      const nextMutation = mutationWaiters.shift()!;
      activeMutations++;
      nextMutation();
    }
  };

  return {
    async runMutation<T>(action: () => Promise<T>): Promise<T> {
      if (reconcileInProgress || reconcileWaiters.length > 0) {
        await new Promise<void>((resolve) => {
          mutationWaiters.push(resolve);
        });
      } else {
        activeMutations++;
      }

      try {
        return await action();
      } finally {
        activeMutations--;
        drainNext();
      }
    },

    async runReconcile<T>(action: () => Promise<T>): Promise<T> {
      if (reconcileInProgress || activeMutations > 0) {
        await new Promise<void>((resolve) => {
          reconcileWaiters.push(resolve);
        });
      } else {
        reconcileInProgress = true;
      }

      try {
        return await action();
      } finally {
        reconcileInProgress = false;
        drainNext();
      }
    },
  };
}
