#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sourcebase.py — 数据源抽象基类（DataSource）

（本模块从 server/server.py 拆出来；模块总索引见 core/__init__.py。）

单独一个文件是为了**避开 import 成环**：PlcSource 要继承它，
而 datasource 要拿 PlcSource 造对象 —— 基类和「造对象的人」放一起就绕回去了。
"""


class DataSource:
    """数据源接口。读写均以「变量名」寻址；变量 → 寄存器地址的映射
    来自前端变量表里用户填写的 address 字段（存在 self._meta 中）。

    地址留空的变量 = **内部变量**：不参与 PLC 读写，值由 HMI 自己维护
    （勾了「保持」的由 RetainStore 落盘）。两种数据源的行为必须一致。"""

    def read_all(self) -> dict:
        raise NotImplementedError

    def read(self, name):
        raise NotImplementedError

    def write(self, name, value):
        raise NotImplementedError

    def meta(self) -> dict:
        """返回 {name: {address, type}} 映射，供真实设备寻址使用。"""
        raise NotImplementedError
