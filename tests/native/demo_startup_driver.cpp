// Test-only UI driver for an unmodified official Linux Prism executable.
// Selects the launcher's built-in demo flow; no account files, entitlements,
// authentication checks, network responses or game contents are modified.
#include <QApplication>
#include <QTimer>
#include <QAbstractButton>
#include <QLineEdit>
#include <QDebug>

static void installDemoDriver() {
    if (qEnvironmentVariable("PRISM_BRIDGE_TEST_DEMO") != "1") return;
    QTimer::singleShot(0, qApp, [] {
        auto *timer = new QTimer(qApp);
        QObject::connect(timer, &QTimer::timeout, [] {
            for (auto *widget : QApplication::topLevelWidgets()) {
                if (!widget->isVisible()) continue;
                const auto title = widget->windowTitle();
                QString wanted;
                if (title.contains("Quick Setup")) wanted = "Finish";
                else if (title.startsWith("No Accounts")) wanted = "No";
                else if (title.startsWith("Play demo?")) wanted = "Play Demo";
                else if (title.startsWith("Player name")) {
                    for (auto *line : widget->findChildren<QLineEdit *>()) line->setText("BridgeTest");
                    wanted = "OK";
                }
                if (wanted.isEmpty()) continue;
                for (auto *button : widget->findChildren<QAbstractButton *>()) {
                    if (button->text().remove('&') == wanted && button->isEnabled() && button->isVisible()) {
                        qInfo() << "ISOLATED_DEMO_DRIVER" << title << wanted;
                        button->click(); break;
                    }
                }
            }
        });
        timer->start(300);
    });
}
Q_COREAPP_STARTUP_FUNCTION(installDemoDriver)
