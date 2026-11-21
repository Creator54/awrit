import android.graphics.Rect;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.*;
import java.lang.reflect.Method;

public class Dumper {
  public static void main(String[] args) throws Exception {
    Class<?> c = Class.forName("com.android.uiautomator.core.UiAutomationShellWrapper");
    Object w = c.getDeclaredConstructor().newInstance();
    c.getMethod("connect").invoke(w);
    Object ua = c.getMethod("getUiAutomation").invoke(w);
    Method root = ua.getClass().getMethod("getRootInActiveWindow");
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
    PrintStream out = new PrintStream(new FileOutputStream(FileDescriptor.out), false, "UTF-8");
    out.println("ready"); out.flush();
    while (in.readLine() != null) {
      // Like stock uiautomator, let a running transition finish; never block more than 1 s.
      try { ua.getClass().getMethod("waitForIdle", long.class, long.class).invoke(ua, 100L, 1000L); } catch (Exception ignored) {}
      StringBuilder sb = new StringBuilder("<hierarchy>");
      AccessibilityNodeInfo r = (AccessibilityNodeInfo) root.invoke(ua);
      if (r != null) walk(r, sb);
      sb.append("</hierarchy>");
      out.println(sb); out.println("\u0001END"); out.flush();
    }
  }
  static void walk(AccessibilityNodeInfo n, StringBuilder sb) {
    if (n.isVisibleToUser()) {
      Rect b = new Rect(); n.getBoundsInScreen(b);
      sb.append("<node text=\"").append(esc(n.getText())).append("\" resource-id=\"").append(esc(n.getViewIdResourceName()))
        .append("\" class=\"").append(esc(n.getClassName())).append("\" content-desc=\"").append(esc(n.getContentDescription()))
        .append("\" checkable=\"").append(n.isCheckable()).append("\" checked=\"").append(n.isChecked())
        .append("\" clickable=\"").append(n.isClickable()).append("\" enabled=\"").append(n.isEnabled())
        .append("\" focused=\"").append(n.isFocused()).append("\" scrollable=\"").append(n.isScrollable())
        .append("\" long-clickable=\"").append(n.isLongClickable()).append("\" password=\"").append(n.isPassword())
        .append("\" selected=\"").append(n.isSelected()).append("\" bounds=\"[").append(b.left).append(",").append(b.top)
        .append("][").append(b.right).append(",").append(b.bottom).append("]\">");
      for (int i = 0; i < n.getChildCount(); i++) { AccessibilityNodeInfo ch = n.getChild(i); if (ch != null) walk(ch, sb); }
      sb.append("</node>");
    }
  }
  static String esc(CharSequence s) {
    if (s == null) return "";
    return s.toString().replace("&","&amp;").replace("<","&lt;").replace(">","&gt;").replace("\"","&quot;").replace("\n","&#10;").replace("\r","&#13;");
  }
}
