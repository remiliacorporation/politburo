"""Signal a verified process: 0 on success, 1 on refusal."""

import os
import signal
import sys


def main():
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        return 1

    try:
        pid_arg, start_time, sig = sys.argv[1:]
        pid = int(pid_arg)
        if pid <= 1:
            return 1
        sig = signal.Signals[sig]

        # Bind to the process before checking its identity. A subsequent PID
        # reuse cannot redirect a signal sent through this fd.
        fd = os.pidfd_open(pid)
        try:
            with open(f"/proc/{pid}/stat", "rb") as stat:
                # After the final ') ', state is field 3 and start time is 22.
                fields = stat.read().rsplit(b") ", 1)[1].split()
            if fields[0] == b"Z" or fields[19] != start_time.encode():
                return 1
            signal.pidfd_send_signal(fd, sig)
            return 0
        finally:
            os.close(fd)
    except (OSError, ValueError, IndexError, KeyError):
        return 1


if __name__ == "__main__":
    sys.exit(main())
