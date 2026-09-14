package android.content;

public class Context {

    public static final String CLIPBOARD_SERVICE = "clipboard";

    public Object getSystemService(String name) {
        return null;
    }

    public Context getApplicationContext() {
        return this;
    }
}
