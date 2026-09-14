package android.os;

public class Handler {

    public Handler() {
    }

    public Handler(Looper looper) {
    }

    public boolean post(Runnable runnable) {
        runnable.run();
        return true;
    }

    public boolean postDelayed(Runnable runnable, long delay) {
        runnable.run();
        return true;
    }
}
