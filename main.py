"""
Entry point for the Stereogram Analyzer GUI application.
"""

from __future__ import annotations

import sys

from PyQt5 import QtWidgets

from stereogram_analyzer.gui import MainWindow


def main() -> int:
    """
    Launch the PyQt5 application.
    """
    app = QtWidgets.QApplication(sys.argv)
    window = MainWindow()
    window.show()
    return app.exec_()


if __name__ == "__main__":
    sys.exit(main())

